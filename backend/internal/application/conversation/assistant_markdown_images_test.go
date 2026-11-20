package conversation

import (
	"context"
	"strings"
	"testing"
)

func TestAssistantMarkdownImageStreamAcrossChunks(t *testing.T) {
	source := "before ![a \\] b](<data:image/jpeg;base64,AAAA> \"title\") after"
	var stream AssistantMarkdownImageStream
	var preview strings.Builder
	for i := range len(source) {
		preview.WriteString(stream.Write(source[i : i+1]))
	}
	preview.WriteString(stream.Finish())
	if got, want := preview.String(), "before ![a \\] b]("+assistantImagePendingURL+") after"; got != want {
		t.Fatalf("preview = %q, want %q", got, want)
	}
	ranges := assistantMarkdownImageRanges(source)
	got := rewriteAssistantMarkdownImageURLs(source, ranges, func(markdownImageRange) string { return "/api/v1/files/example/content" })
	want := strings.Replace(source, "data:image/jpeg;base64,AAAA", "/api/v1/files/example/content", 1)
	if got != want {
		t.Fatalf("rewrite = %q, want %q", got, want)
	}
}

func TestAssistantMarkdownImagesIgnoreCodeAndEscape(t *testing.T) {
	image := "![name](data:image/png;base64,AAAA)"
	source := "\\" + image + "\n\n`" + image + "`\n\n```md\n" + image + "\n```\n\n" + image
	if ranges := assistantMarkdownImageRanges(source); len(ranges) != 1 || ranges[0].start != strings.LastIndex(source, image) {
		t.Fatalf("unexpected image ranges: %+v", ranges)
	}
}

func TestAssistantMarkdownImageInQuotedFenceStaysLiteral(t *testing.T) {
	image := "![name](data:image/png;base64,AAAA)"
	for _, quote := range []string{
		"> ```md\n> " + image + "\n> ```\n\n",
		"> > ~~~md\n> > " + image + "\n\n",
	} {
		source := quote + image
		if ranges := assistantMarkdownImageRanges(source); len(ranges) != 1 || ranges[0].start != len(quote) {
			t.Fatalf("unexpected image ranges: %+v", ranges)
		}
		var stream AssistantMarkdownImageStream
		var preview strings.Builder
		for i := range len(source) {
			preview.WriteString(stream.Write(source[i : i+1]))
		}
		preview.WriteString(stream.Finish())
		if want := quote + "![name](" + assistantImagePendingURL + ")"; preview.String() != want {
			t.Fatalf("unexpected streamed quote: %q", preview.String())
		}
	}
}

func TestInterruptedAssistantMarkdownKeepsCompletedImage(t *testing.T) {
	complete := "![complete](data:image/png;base64,AAAA)"
	if got, want := omitUnfinishedAssistantMarkdownImages(complete+"\n\n![partial](data:image/png;base64,AAAA"), complete+"\n\n![partial]("+assistantImageFailedURL+")"; got != want {
		t.Fatalf("interrupted result = %q, want %q", got, want)
	}
}

func TestMalformedAssistantMarkdownImageKeepsFollowingParagraph(t *testing.T) {
	for _, image := range []string{"![alt](<data:image/png;base64,AAAA>", "![alt](data:image/png;base64,AAAA \"bad title"} {
		source := image + "\n\n后续正文"
		var stream AssistantMarkdownImageStream
		got := stream.Write(source) + stream.Finish()
		if want := "![alt](" + assistantImagePendingURL + ")\n\n后续正文"; got != want {
			t.Fatalf("preview = %q, want %q", got, want)
		}
		if got := omitUnfinishedAssistantMarkdownImages(source); !strings.HasSuffix(got, "\n\n后续正文") {
			t.Fatalf("completion = %q", got)
		}
	}
}

func TestInvalidAssistantMarkdownImageKeepsSurroundingText(t *testing.T) {
	service := &Service{}
	input := assistantImageContentInput{Content: "pre ![alt](data:image/jpeg;base64,bad) post"}
	got, err := service.normalizeAssistantImageContent(context.Background(), input)
	if err != nil || got == nil || got.Content != "pre ![alt]("+assistantImageFailedURL+") post" || len(got.AttachmentRows) != 0 {
		t.Fatalf("unexpected result: %+v %v", got, err)
	}
	if got := omitUnfinishedAssistantMarkdownImages("pre ![alt](data:image/jpeg;base64,AAAA"); got != "pre ![alt]("+assistantImageFailedURL+")" {
		t.Fatalf("truncated = %q", got)
	}
}
