package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"
)

// printable makes one line of a log safe to show in a terminal: control characters (escape
// sequences among them) become question marks, a tab a space. The service never writes them; a
// file somebody else wrote might.
func printable(line string) string {
	var out strings.Builder
	for _, character := range strings.TrimRight(line, "\r") {
		switch {
		case character == '\t':
			out.WriteByte(' ')
		case character < 0x20 || (character >= 0x7f && character <= 0x9f) || character == 0x2028 || character == 0x2029:
			out.WriteByte('?')
		default:
			out.WriteRune(character)
		}
	}
	return out.String()
}

// tailWindow is how much of the end of a log is read to find its last lines.
const tailWindow = 512 * 1024

// TailLines is the last n lines of a log file and the size of the file as it was read, to follow
// from. A file that is not there has no lines.
func TailLines(path string, n int) ([]string, int64, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := info.Size()
	start := int64(0)
	if size > tailWindow {
		start = size - tailWindow
	}
	data := make([]byte, size-start)
	if _, err := file.ReadAt(data, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, err
	}
	if start > 0 {
		// The window began in the middle of a line: drop the part of it.
		if cut := bytes.IndexByte(data, '\n'); cut >= 0 {
			data = data[cut+1:]
		}
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil, size, nil
	}
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	for index, line := range lines {
		lines[index] = printable(line)
	}
	return lines, size, nil
}

// Follow writes the lines added to a log after offset until the context ends. A file that shrinks
// (it was rotated) is read again from its start.
func Follow(ctx context.Context, path string, offset int64, interval time.Duration, write func(line string)) error {
	pending := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if info.Size() < offset {
			offset, pending = 0, ""
		}
		if info.Size() == offset {
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		chunk := make([]byte, info.Size()-offset)
		read, _ := file.ReadAt(chunk, offset)
		file.Close()
		offset += int64(read)
		pending += string(chunk[:read])
		for {
			cut := strings.IndexByte(pending, '\n')
			if cut < 0 {
				break
			}
			write(printable(pending[:cut]))
			pending = pending[cut+1:]
		}
	}
}
