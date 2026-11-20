package conversation

import (
	"strings"
)

const (
	assistantImagePendingURL = "#deeix-inline-image-pending"
	assistantImageFailedURL  = "#deeix-inline-image-unavailable"
	maxMarkdownImageHeader   = 4096
)

type markdownImageRange struct {
	start, destination, end int
	complete                bool
}

// AssistantMarkdownImageStream replaces embedded image payloads before text is
// sent or retained for replay. The application still receives the unmodified
// completion, so it can save the image and replace the placeholder atomically.
// Only an ambiguous image header or delimiter can carry over between chunks.
type AssistantMarkdownImageStream struct {
	pending        string
	offset         int
	lineIndent     int // -1 after the first non-prefix byte on this line
	quoteDepth     int
	quotePadding   bool
	fenceQuote     int
	fence          byte
	fenceLength    int
	inlineTicks    int
	escaped        bool
	image          *markdownImageRange
	imageQuote     byte
	imageAngle     bool
	imagePrevSpace bool
	onImage        func(markdownImageRange)
}

func (s *AssistantMarkdownImageStream) Write(delta string) string { return s.consume(delta, false) }
func (s *AssistantMarkdownImageStream) Finish() string            { return s.consume("", true) }

func (s *AssistantMarkdownImageStream) consume(delta string, final bool) string {
	text := s.pending + delta
	s.pending = ""
	var out strings.Builder
	// For the completion parser only offsets matter; never copy the rest of a huge message.
	write := func(value string) {
		if s.onImage == nil {
			out.WriteString(value)
		}
	}
	i := 0
scan:
	for i < len(text) {
		c := text[i]
		if s.image != nil && (c == '\n' || c == '\r') {
			// Keep the line boundary even if the destination was followed by a
			// malformed angle link or title. Never eat the next paragraph.
			s.image.end = s.offset + i
			s.emitImageRange()
		}
		if s.image != nil {
			switch {
			case s.imageQuote != 0:
				if c == s.imageQuote && !s.escaped {
					s.imageQuote = 0
				}
				s.escaped = c == '\\' && !s.escaped
			case s.imageAngle && c == '>':
				s.image.end = s.offset + i
				s.imageAngle = false
			case !s.imageAngle && c == ')':
				if s.image.end == 0 {
					s.image.end = s.offset + i
				}
				s.image.complete = true
				s.emitImageRange()
			case !s.imageAngle && s.imagePrevSpace && (c == '"' || c == '\'' || c == '('):
				if s.image.end == 0 {
					s.image.end = s.offset + i
				}
				s.imageQuote = c
				if c == '(' {
					s.imageQuote = ')'
				}
			}
			s.imagePrevSpace = c == ' ' || c == '\t' || c == '\r' || c == '\n'
			s.advance(c)
			i++
			continue
		}
		// Quoted fences are scoped to the block quote. A line with fewer
		// quote markers terminates that fence, even if it had no closer.
		if s.lineIndent >= 0 && c != ' ' && c != '\t' && c != '\r' && c != '>' && s.quoteDepth < s.fenceQuote {
			s.fence, s.fenceQuote = 0, 0
		}
		if !s.escaped && (c == '`' || c == '~') {
			end := i + 1
			for end < len(text) && text[end] == c {
				end++
			}
			if end == len(text) && !final && end-i < maxMarkdownImageHeader {
				break scan
			}
			length := end - i
			atMargin := s.lineIndent >= 0 && s.lineIndent < 4
			if s.fence != 0 {
				if atMargin && s.quoteDepth == s.fenceQuote && c == s.fence && length >= s.fenceLength {
					tail := end
					for tail < len(text) && (text[tail] == ' ' || text[tail] == '\t' || text[tail] == '\r') {
						tail++
					}
					if tail == len(text) && !final && tail-i < maxMarkdownImageHeader {
						break scan
					}
					if tail == len(text) || text[tail] == '\n' {
						s.fence, s.fenceQuote = 0, 0
					}
				}
			} else if s.inlineTicks == 0 && atMargin && length >= 3 {
				s.fence, s.fenceLength, s.fenceQuote = c, length, s.quoteDepth
			} else if c == '`' {
				if s.inlineTicks == 0 {
					s.inlineTicks = length
				} else if s.inlineTicks == length {
					s.inlineTicks = 0
				}
			}
			write(text[i:end])
			s.advance(c)
			i = end
			continue
		}
		if c == '!' && !s.escaped && s.fence == 0 && s.inlineTicks == 0 && s.lineIndent < 4 {
			header, more := parseMarkdownImageHeader(text[i:], final)
			if more {
				break scan
			}
			if header != nil {
				image := markdownImageRange{start: s.offset + i, destination: s.offset + i + header.destination}
				s.image = &image
				s.imageAngle = header.angle
				s.imagePrevSpace = false
				if s.onImage == nil {
					write(text[i:i+header.labelEnd] + "(" + assistantImagePendingURL + ")")
				}
				s.advance('!')
				i += header.payload
				continue
			}
		}
		write(text[i : i+1])
		s.advance(c)
		if s.fence == 0 {
			s.escaped = c == '\\' && !s.escaped
		}
		i++
	}
	s.offset += i
	if i < len(text) {
		s.pending = strings.Clone(text[i:])
	}
	if final && s.image != nil {
		s.image.end = s.offset
		s.emitImageRange()
	}
	return out.String()
}

func (s *AssistantMarkdownImageStream) emitImageRange() {
	if s.onImage != nil {
		s.onImage(*s.image)
	}
	s.image = nil
}

func (s *AssistantMarkdownImageStream) advance(c byte) {
	if s.quotePadding {
		s.quotePadding = false
		if c == ' ' || c == '\t' {
			return
		}
	}
	switch c {
	case '\n':
		s.lineIndent, s.quoteDepth = 0, 0
	case '>':
		if s.lineIndent >= 0 && s.lineIndent < 4 {
			s.lineIndent = 0
			s.quoteDepth++
			s.quotePadding = true
		} else {
			s.lineIndent = -1
		}
	case ' ':
		if s.lineIndent >= 0 {
			s.lineIndent++
		}
	case '\t':
		if s.lineIndent >= 0 {
			s.lineIndent = 4
		}
	default:
		s.lineIndent = -1
	}
}

type markdownImageHeader struct {
	labelEnd, destination, payload int
	angle                          bool
}

func parseMarkdownImageHeader(source string, final bool) (*markdownImageHeader, bool) {
	limit := min(len(source), maxMarkdownImageHeader)
	more := !final && len(source) < maxMarkdownImageHeader
	if limit == 1 {
		return nil, more
	}
	if source[1] != '[' {
		return nil, false
	}
	depth := 1
	var i int
	for i = 2; i < limit && depth > 0; i++ {
		switch source[i] {
		case '\\':
			i++
		case '[':
			depth++
		case ']':
			depth--
		case '\n', '\r':
			return nil, false
		}
	}
	if i >= limit {
		return nil, more
	}
	if source[i] != '(' {
		return nil, false
	}
	header := markdownImageHeader{labelEnd: i}
	i++
	for i < limit && (source[i] == ' ' || source[i] == '\t') {
		i++
	}
	if i < limit && source[i] == '<' {
		header.angle = true
		i++
	}
	header.destination = i
	i, morePrefix, ok := matchImageHeaderPrefix(source[:limit], i, "data:image/")
	if !ok {
		return nil, more && morePrefix
	}
	start := i
	for i < limit && isImageSubtypeByte(source[i]) {
		i++
	}
	if i-start > 48 || (i == start && i < limit) {
		return nil, false
	}
	end, morePrefix, ok := matchImageHeaderPrefix(source[:limit], i, ";base64,")
	if !ok {
		return nil, more && morePrefix
	}
	header.payload = end
	return &header, false
}

func matchImageHeaderPrefix(source string, start int, prefix string) (int, bool, bool) {
	count := min(len(source)-start, len(prefix))
	if !strings.EqualFold(source[start:start+count], prefix[:count]) {
		return 0, false, false
	}
	return start + count, count < len(prefix), count == len(prefix)
}

func isImageSubtypeByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'
}

func assistantMarkdownImageRanges(content string) []markdownImageRange {
	if !strings.Contains(content, "![") {
		return nil
	}
	var ranges []markdownImageRange
	scanner := AssistantMarkdownImageStream{onImage: func(image markdownImageRange) { ranges = append(ranges, image) }}
	scanner.consume(content, true)
	return ranges
}

func rewriteAssistantMarkdownImageURLs(content string, ranges []markdownImageRange, imageURL func(markdownImageRange) string) string {
	var out strings.Builder
	last := 0
	for _, image := range ranges {
		out.WriteString(content[last:image.destination])
		destination := imageURL(image)
		out.WriteString(destination)
		if image.complete {
			// Keep the separator before an optional title after replacing the payload.
			end := image.end
			for end > image.destination && (content[end-1] == ' ' || content[end-1] == '\t') {
				end--
			}
			out.WriteString(content[end:image.end])
		} else {
			if image.destination > 0 && content[image.destination-1] == '<' {
				out.WriteByte('>')
			}
			out.WriteByte(')')
		}
		last = image.end
	}
	out.WriteString(content[last:])
	return out.String()
}

func omitUnfinishedAssistantMarkdownImages(content string) string {
	ranges := assistantMarkdownImageRanges(content)
	unfinished := ranges[:0]
	for _, image := range ranges {
		if !image.complete {
			unfinished = append(unfinished, image)
		}
	}
	if len(unfinished) == 0 {
		return content
	}
	return rewriteAssistantMarkdownImageURLs(content, unfinished, func(markdownImageRange) string { return assistantImageFailedURL })
}
