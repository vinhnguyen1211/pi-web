package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Agent wraps a single `pi --mode rpc` subprocess.
type Agent struct {
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	lines        chan string  // buffered channel for stdout JSONL lines
	done         chan struct{} // closed when the stdout goroutine exits
	sessionPath  string        // path to the session .jsonl file (empty for new sessions)
	lastActivity time.Time     // last time this agent had an active connection or command
}

// New spawns pi in RPC mode and returns an Agent.
// args should already include "--mode", "rpc" and any additional flags.
func New(cwd string, args ...string) (*Agent, error) {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	cmd := exec.Command("pi", args...)
	cmd.Dir = cwd

	// Capture stderr so we can log it
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("agent: stderr pipe: %w", err)
	}

	// Stdin pipe for sending commands
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("agent: stdin pipe: %w", err)
	}

	// Stdout pipe for reading events
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("agent: stdout pipe: %w", err)
	}

	lines := make(chan string, 256)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("agent: start: %w", err)
	}

	a := &Agent{
		cmd:          cmd,
		stdin:        stdin,
		lines:        lines,
		done:         make(chan struct{}),
		lastActivity: time.Now(),
	}

	// Extract session path from args if present
	for i, arg := range args {
		if arg == "--session" && i+1 < len(args) {
			a.sessionPath = args[i+1]
		}
	}

	// Tail stderr in background
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[pi stderr] %s", scanner.Text())
		}
	}()

	// Read stdout line-by-line in background
	go a.readLoop(stdout)

	return a, nil
}

// readLoop reads from stdout, splits on \n (not Unicode separators), strips trailing \r,
// and sends each line through the lines channel. Closes the channel when done.
func (a *Agent) readLoop(stdout io.Reader) {
	defer close(a.lines)

	reader := bufio.NewReader(stdout)
	var buf []byte

	for {
		lineBytes, isPrefix, err := reader.ReadLine() // splits on \n only
		if err != nil {
			return // EOF or error
		}

		// Accumulate if the line was too long (split into multiple reads)
		buf = append(buf, lineBytes...)
		if isPrefix {
			continue
		}

		line := string(buf)
		buf = nil

		// Strip trailing \r for CRLF input
		line = strings.TrimRight(line, "\r")

		if len(line) == 0 {
			continue // skip empty lines
		}

		select {
		case a.lines <- line:
		default:
			log.Println("agent: channel full, dropping event")
		}
	}
}

// Lines returns the receive-only channel of stdout JSONL lines.
func (a *Agent) Lines() <-chan string {
	return a.lines
}

// SendCommand marshals obj to JSON and writes it to pi's stdin followed by \n.
func (a *Agent) SendCommand(obj map[string]any) error {
	data, err := json.Marshal(obj)
	if err != nil {
		return fmt.Errorf("agent: marshal: %w", err)
	}

	_, err = a.stdin.Write(append(data, '\n'))
	if err != nil {
		return fmt.Errorf("agent: write stdin: %w", err)
	}

	return nil
}

// Kill sends SIGTERM to the pi subprocess and waits for it to exit.
func (a *Agent) Kill() error {
	if a.cmd.Process == nil {
		return nil
	}

	if err := a.cmd.Process.Signal(os.Interrupt); err != nil {
		_ = a.cmd.Process.Kill()
	}

	// Wait for the process to finish in a goroutine so we don't block forever
	done := make(chan error, 1)
	go func() { done <- a.cmd.Wait() }()

	select {
	case err := <-done:
		return err
	default:
		_ = a.cmd.Process.Kill()
		return <-done
	}
}

// Wait blocks until the pi subprocess exits.
func (a *Agent) Wait() error {
	<-a.done
	return a.cmd.Wait()
}

// PID returns the process ID of the pi subprocess.
func (a *Agent) PID() int {
	if a.cmd.Process == nil {
		return 0
	}
	return a.cmd.Process.Pid
}

// SessionPath returns the session file path this agent is bound to.
func (a *Agent) SessionPath() string {
	return a.sessionPath
}

// Touch resets the last-activity timestamp.
func (a *Agent) Touch() {
	a.lastActivity = time.Now()
}

// TimeSinceActivity returns how long it has been since the last activity.
func (a *Agent) TimeSinceActivity() time.Duration {
	return time.Since(a.lastActivity)
}

// IsAlive sends signal 0 to check if the process is still running.
// Returns true if alive, false if dead or no process.
func (a *Agent) IsAlive() bool {
	if a.cmd.Process == nil {
		return false
	}
	// Signal 0 is a no-op that checks process existence
	return a.cmd.Process.Signal(nil) == nil
}
