package conversation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

const maxAssistantImageContentItems = 8

var markdownDataImageRE = regexp.MustCompile(`(?is)^!\[[^\]]*\]\((data:image/[^)]+)\)$`)

type assistantImageContentNormalization struct {
	Content             string
	ContentType         string
	AttachmentRows      []model.Attachment
	AttachmentSnapshots []AttachmentInput
}

type assistantImageCandidate struct {
	Value    string
	MIMEType string
}

type assistantImagePayload struct {
	Bytes    []byte
	MIMEType string
}

type assistantImageContentInput struct {
	UserID             uint
	ConversationID     uint
	AssistantMessageID uint
	ModelName          string
	Content            string
	ArtifactSource     mediaArtifactSource
	GeneratedImages    []llm.GeneratedImage
	OnSaving           func()
	OnSaved            func(model.FileObject, []byte)
}

type assistantImageReadError struct {
	index int
	err   error
}

func (e *assistantImageReadError) Error() string { return e.err.Error() }
func (e *assistantImageReadError) Unwrap() error { return e.err }

// normalizeAssistantImageContent is the shared save path for chat and image tasks.
// An image may appear in either output field or in both, so inspect both fields.
func (s *Service) normalizeAssistantImageContent(ctx context.Context, input assistantImageContentInput) (*assistantImageContentNormalization, error) {
	return s.normalizeAssistantImageContentWithRanges(ctx, input, assistantMarkdownImageRanges(input.Content))
}

func (s *Service) normalizeAssistantImageContentWithRanges(ctx context.Context, input assistantImageContentInput, ranges []markdownImageRange) (*assistantImageContentNormalization, error) {
	saver := assistantImageSaver{service: s, input: input, now: time.Now()}
	content := input.Content
	imageOnly := false
	if len(ranges) > 0 {
		content = saver.saveMarkdownImages(ctx, ranges)
		imageOnly = markdownDataImageRE.MatchString(strings.TrimSpace(input.Content))
	} else if !markdownDataImageRE.MatchString(unwrapAssistantImageContent(input.Content)) {
		// A fenced Markdown example is code, not an image to persist.
		candidates := extractAssistantImageCandidates(input.Content)
		for _, candidate := range candidates {
			data, mimeType, ok := decodeAssistantImageCandidate(candidate)
			if !ok {
				continue
			}
			if _, err := saver.save(ctx, assistantImagePayload{Bytes: data, MIMEType: mimeType}, sha256.Sum256(data), len(candidates)+len(input.GeneratedImages)); err != nil {
				return nil, err
			}
		}
		if len(saver.files) != 0 {
			content = generatedImageMarkdown(saver.files)
			imageOnly = true
		}
	}

	textFileCount := len(saver.files)
	for i, image := range input.GeneratedImages {
		data, mimeType, err := s.readGeneratedImage(ctx, image, input.ArtifactSource)
		if err != nil {
			return nil, &assistantImageReadError{index: i + 1, err: err}
		}
		if _, err := saver.save(ctx, assistantImagePayload{Bytes: data, MIMEType: mimeType}, sha256.Sum256(data), textFileCount+len(input.GeneratedImages)); err != nil {
			return nil, err
		}
	}
	if len(saver.files) > textFileCount {
		markdown := generatedImageMarkdown(saver.files[textFileCount:])
		if strings.TrimSpace(content) == "" {
			content, imageOnly = markdown, true
		} else {
			content += "\n\n" + markdown
		}
	}
	if len(saver.files) == 0 && len(ranges) == 0 {
		return nil, nil
	}
	contentType := "text"
	if len(saver.files) != 0 {
		contentType = "mixed"
		if imageOnly {
			contentType = "image"
		}
	}
	return &assistantImageContentNormalization{
		Content:             content,
		ContentType:         contentType,
		AttachmentRows:      saver.attachments,
		AttachmentSnapshots: attachmentsFromFiles(saver.files),
	}, nil
}

type assistantImageSaver struct {
	service     *Service
	input       assistantImageContentInput
	now         time.Time
	byDigest    map[[sha256.Size]byte]string
	files       []model.FileObject
	attachments []model.Attachment
}

// saveMarkdownImages changes only image destinations. Invalid/over-limit images
// leave a placeholder without making the rest of the reply fail.
func (w *assistantImageSaver) saveMarkdownImages(ctx context.Context, ranges []markdownImageRange) string {
	byDestination := make(map[int]string)
	// Cache empty file IDs for failed uploads so repeated Markdown images do not retry.
	attemptedFileIDs := make(map[[sha256.Size]byte]string)
	totalBytes := 0
	storageFailed := false
	for i, image := range ranges {
		if i >= maxAssistantImageContentItems {
			break
		}
		if !image.complete {
			continue
		}
		url := strings.TrimSpace(w.input.Content[image.destination:image.end])
		candidate, ok := assistantImageCandidateFromString(url, false)
		if !ok {
			continue
		}
		data, mimeType, ok := decodeAssistantImageCandidate(candidate)
		if !ok {
			continue
		}
		digest := sha256.Sum256(data)
		fileID, seen := attemptedFileIDs[digest]
		if !seen {
			if len(data) > maxGeneratedImageBytes-totalBytes {
				continue
			}
			totalBytes += len(data)
			var err error
			fileID, err = w.save(ctx, assistantImagePayload{Bytes: data, MIMEType: mimeType}, digest, len(ranges)+len(w.input.GeneratedImages))
			storageFailed = storageFailed || err != nil
			attemptedFileIDs[digest] = fileID
		}
		byDestination[image.destination] = fileID
	}
	if storageFailed && w.service.logger != nil {
		// Avoid logging the reply or its Base64 payload.
		w.service.logger.Warn("assistant_markdown_image_storage_failed")
	}
	return rewriteAssistantMarkdownImageURLs(w.input.Content, ranges, func(image markdownImageRange) string {
		if fileID := byDestination[image.destination]; fileID != "" {
			return "/api/v1/files/" + fileID + "/content"
		}
		return assistantImageFailedURL
	})
}

func (w *assistantImageSaver) save(ctx context.Context, image assistantImagePayload, digest [sha256.Size]byte, count int) (string, error) {
	if id := w.byDigest[digest]; id != "" {
		return id, nil
	}
	if w.input.OnSaving != nil {
		w.input.OnSaving()
		w.input.OnSaving = nil
	}
	fileName := generatedImageFileName(w.input.ModelName, w.now, len(w.files), count, image.MIMEType)
	result, err := w.service.uploadSvc.UploadFile(ctx, appupload.UploadFileInput{
		UserID:       w.input.UserID,
		Purpose:      "generated_image",
		FileName:     fileName,
		MimeType:     image.MIMEType,
		DeclaredSize: int64(len(image.Bytes)),
		Reader:       bytes.NewReader(image.Bytes),
		MaxBytes:     maxGeneratedImageBytes,
	})
	if err != nil {
		return "", err
	}
	file := result.File
	if w.byDigest == nil {
		w.byDigest = make(map[[sha256.Size]byte]string)
	}
	w.byDigest[digest] = file.FileID
	w.files = append(w.files, file)
	w.attachments = append(w.attachments, model.Attachment{
		ConversationID: w.input.ConversationID,
		MessageID:      w.input.AssistantMessageID,
		UserID:         w.input.UserID,
		FileID:         file.FileID,
		Kind:           "image",
		FileName:       file.FileName,
		MimeType:       file.DetectedMIME,
		FileSize:       file.SizeBytes,
		SHA256:         file.SHA256,
		StoragePath:    file.StoragePath,
		Status:         "active",
		UploadedAt:     w.now,
	})
	if w.input.OnSaved != nil {
		w.input.OnSaved(file, image.Bytes)
	}
	return file.FileID, nil
}

func extractAssistantImageCandidates(content string) []assistantImageCandidate {
	text := unwrapAssistantImageContent(content)
	if text == "" {
		return nil
	}
	if candidate, ok := markdownDataImageCandidate(text); ok {
		return []assistantImageCandidate{candidate}
	}
	if candidate, ok := directAssistantImageCandidate(text); ok {
		return []assistantImageCandidate{candidate}
	}
	if !strings.HasPrefix(text, "{") && !strings.HasPrefix(text, "[") {
		return nil
	}
	var payload any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil
	}
	candidates := make([]assistantImageCandidate, 0, 1)
	collectAssistantImageCandidates(payload, "", &candidates)
	return candidates
}

func unwrapAssistantImageContent(content string) string {
	text := strings.TrimSpace(content)
	if !strings.HasPrefix(text, "```") {
		return text
	}
	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		return text
	}
	if !strings.HasPrefix(strings.TrimSpace(lines[0]), "```") {
		return text
	}
	end := len(lines)
	for end > 1 && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	if end <= 1 || !strings.HasPrefix(strings.TrimSpace(lines[end-1]), "```") {
		return text
	}
	return strings.TrimSpace(strings.Join(lines[1:end-1], "\n"))
}

func markdownDataImageCandidate(text string) (assistantImageCandidate, bool) {
	matches := markdownDataImageRE.FindStringSubmatch(strings.TrimSpace(text))
	if len(matches) != 2 {
		return assistantImageCandidate{}, false
	}
	return assistantImageCandidateFromString(matches[1], true)
}

func directAssistantImageCandidate(text string) (assistantImageCandidate, bool) {
	if candidate, ok := assistantImageCandidateFromString(text, true); ok {
		return candidate, true
	}
	if !isLikelyBase64Payload(text) {
		return assistantImageCandidate{}, false
	}
	return assistantImageCandidate{Value: text}, true
}

func collectAssistantImageCandidates(value any, key string, result *[]assistantImageCandidate) {
	if len(*result) >= maxAssistantImageContentItems {
		return
	}
	switch typed := value.(type) {
	case string:
		if candidate, ok := assistantImageCandidateFromString(typed, assistantImagePayloadKey(key)); ok {
			*result = append(*result, candidate)
		}
	case []any:
		for _, item := range typed {
			collectAssistantImageCandidates(item, key, result)
			if len(*result) >= maxAssistantImageContentItems {
				return
			}
		}
	case map[string]any:
		for childKey, childValue := range typed {
			collectAssistantImageCandidates(childValue, childKey, result)
			if len(*result) >= maxAssistantImageContentItems {
				return
			}
		}
	}
}

func assistantImageCandidateFromString(value string, allowRawBase64 bool) (assistantImageCandidate, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return assistantImageCandidate{}, false
	}
	mimeType := dataURLImageMIMEType(text)
	if mimeType != "" {
		return assistantImageCandidate{Value: text, MIMEType: mimeType}, true
	}
	if allowRawBase64 && isLikelyBase64Payload(text) {
		return assistantImageCandidate{Value: text}, true
	}
	return assistantImageCandidate{}, false
}

func assistantImagePayloadKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "b64_json", "base64", "image", "image_base64", "image_b64", "data", "result":
		return true
	default:
		return false
	}
}

func dataURLImageMIMEType(value string) string {
	text := strings.TrimSpace(value)
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "data:image/") {
		return ""
	}
	semicolon := strings.Index(text, ";")
	comma := strings.Index(text, ",")
	if semicolon < len("data:image/")+1 || comma < 0 || semicolon > comma || !strings.EqualFold(text[semicolon:comma], ";base64") {
		return ""
	}
	return strings.TrimSpace(text[len("data:"):semicolon])
}

func isLikelyBase64Payload(value string) bool {
	normalized := normalizeBase64ImagePayload(value)
	if len(normalized) < 64 {
		return false
	}
	for _, item := range normalized {
		if (item >= 'A' && item <= 'Z') || (item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '+' || item == '/' || item == '=' {
			continue
		}
		return false
	}
	return true
}

func decodeAssistantImageCandidate(candidate assistantImageCandidate) ([]byte, string, bool) {
	raw := stripBase64DataURLPrefix(candidate.Value)
	// Bound allocations before normalization and decoding, including malformed inputs.
	limit := base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)
	if len(raw) > limit+limit/8 {
		return nil, "", false
	}
	encoded := normalizeBase64ImagePayload(raw)
	if encoded == "" || len(encoded) > limit {
		return nil, "", false
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	if err != nil {
		return nil, "", false
	}
	if len(data) > maxGeneratedImageBytes {
		return nil, "", false
	}
	data, mimeType, err := validateGeneratedImageBytes(data, candidate.MIMEType)
	if err != nil {
		return nil, "", false
	}
	return data, mimeType, true
}

func normalizeBase64ImagePayload(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for _, item := range value {
		switch item {
		case ' ', '\n', '\r', '\t':
			continue
		default:
			builder.WriteRune(item)
		}
	}
	return builder.String()
}
