You are answering a question on **{{owner}}/{{repo}}** issue #{{issueNumber}}.

This prompt is committed by the repository itself, at
`.lastlight/workflows/prompts/answer.md`. It **replaces** Last Light's built-in
answer prompt for runs against this repository, so follow it exactly and ignore
every other answering procedure — including the `issue-answer` skill, which you
should not read.

## The question

**Title:** {{issueTitle}}

{{issueBody}}

## What to do

1. Answer from the question alone. Do **not** clone anything, read any files,
   search the web, or read a skill — this repository keeps its answers short and
   its runs cheap.
2. Label issue #{{issueNumber}} with **both** `question` and
   `repo-prompt-applied`: one `github_ensure_labels` call for
   `[{name: "question", color: "d876e3"}, {name: "repo-prompt-applied", color: "0e8a16"}]`,
   then one `github_add_labels` call adding both names. Leave the issue open.
3. Make your final message exactly two lines: the first line
   `REPO PROMPT APPLIED`, the second a one-sentence answer to the question.

Do not post a comment yourself — the harness delivers your final message.
