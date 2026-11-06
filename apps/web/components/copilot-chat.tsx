"use client";

import type { CopilotAnswer, TaskProposal } from "@gym/core/copilot";
import { Alert, Button } from "@gym/ui";
import { Sparkles } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import {
  askCopilotAction,
  createProposedTaskAction,
} from "@/app/(staff)/(app)/copilot/actions";

type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; answer: CopilotAnswer }
  | { role: "error"; content: string };

/** Renders the answer text: paragraphs and "- " bullets, nothing else (no HTML from the model). */
function AnswerText({ text }: { text: string }) {
  const blocks: { kind: "p" | "ul"; lines: string[] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^([-*•]|\d+[.)])\s+/.exec(line);
    const content = bullet ? line.slice(bullet[0].length) : line;
    const kind = bullet ? "ul" : "p";
    const last = blocks.at(-1);
    if (kind === "ul" && last?.kind === "ul") last.lines.push(content);
    else blocks.push({ kind, lines: [content] });
  }
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="list-disc pl-5">
            {b.lines.map((l, j) => (
              <li key={j}>{l.replace(/\*\*/g, "")}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.lines[0]!.replace(/\*\*/g, "")}</p>
        ),
      )}
    </div>
  );
}

function ProposalCard({ p }: { p: TaskProposal }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<"idle" | "saving" | "done" | string>(
    "idle",
  );
  const [, start] = useTransition();
  const confirm = () => {
    setState("saving");
    start(async () => {
      const r = await createProposedTaskAction(p);
      setState(r.ok ? "done" : r.error.message);
      if (r.ok) ref.current?.close();
    });
  };
  return (
    <div
      className="rounded-md border border-border bg-background p-3 text-sm"
      data-proposal
    >
      <p className="font-medium">Suggested task: {p.title}</p>
      <p className="text-muted">
        For {p.who} · due {p.due.replace("T", " ")}
      </p>
      {state === "done" ? (
        <p className="mt-2 text-success" role="status">
          Task created.{" "}
          <a className="text-primary hover:underline" href="/tasks">
            Open tasks
          </a>
        </p>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => ref.current?.showModal()}
        >
          Create this task…
        </Button>
      )}
      <dialog
        ref={ref}
        aria-labelledby={`p-${p.title}`}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-5 text-foreground backdrop:bg-black/40"
      >
        <h2 id={`p-${p.title}`} className="text-base font-semibold">
          Create this follow-up task?
        </h2>
        <p className="mt-2 text-sm">
          “{p.title}” for {p.who}, due {p.due.replace("T", " ")}.
        </p>
        <p className="mt-1 text-xs text-muted">
          The Copilot suggested it; nothing is created until you confirm.
        </p>
        {state !== "idle" && state !== "saving" && state !== "done" && (
          <Alert tone="danger" className="mt-3">
            {state}
          </Alert>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => ref.current?.close()}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={confirm} disabled={state === "saving"}>
            {state === "saving" ? "Creating…" : "Create task"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}

export function CopilotChat({
  suggestions,
  fake,
}: {
  suggestions: string[];
  fake: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, start] = useTransition();
  const ask = (q: string) => {
    const text = q.trim();
    if (text.length < 3 || pending) return;
    const history = turns
      .filter(
        (t): t is Extract<Turn, { role: "user" | "assistant" }> =>
          t.role !== "error",
      )
      .slice(-6)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }));
    setTurns((t) => [...t, { role: "user", content: text }]);
    setQuestion("");
    start(async () => {
      const r = await askCopilotAction({ question: text, history });
      setTurns((t) => [
        ...t,
        r.ok
          ? { role: "assistant", content: r.data.answer, answer: r.data }
          : { role: "error", content: r.error.message },
      ]);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {fake && (
        <Alert tone="info" title="Development mode">
          Answers come from the built-in fake provider: it picks tools by
          keywords and repeats the figures they return.
        </Alert>
      )}
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Example questions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm hover:border-primary"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <ol
        className="flex flex-col gap-4"
        aria-live="polite"
        aria-label="Conversation"
      >
        {turns.map((t, i) => (
          <li
            key={i}
            className={t.role === "user" ? "self-end" : "self-stretch"}
          >
            {t.role === "user" ? (
              <p className="max-w-xl rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {t.content}
              </p>
            ) : t.role === "error" ? (
              <Alert tone="danger">{t.content}</Alert>
            ) : (
              <article
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-sm"
                data-copilot-answer
                data-outcome={t.answer.outcome}
              >
                <div className="flex items-center gap-2 text-xs text-muted">
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  {t.answer.mode === "FALLBACK"
                    ? "Summary of your data"
                    : "Copilot"}
                </div>
                <AnswerText text={t.content} />
                {t.answer.warning && (
                  <Alert tone="warning">{t.answer.warning}</Alert>
                )}
                {t.answer.proposals.map((p, j) => (
                  <ProposalCard key={j} p={p} />
                ))}
                {t.answer.sources.length > 0 && (
                  <div className="text-xs">
                    <span className="font-medium text-muted">Sources: </span>
                    {t.answer.sources.map((s, j) => (
                      <span key={j}>
                        {j > 0 && " · "}
                        {s.href ? (
                          <a
                            href={s.href}
                            className="text-primary hover:underline"
                          >
                            {s.label}
                          </a>
                        ) : (
                          s.label
                        )}
                      </span>
                    ))}
                    {t.answer.results[0]?.period && (
                      <span className="text-muted">
                        {" "}
                        · period {t.answer.results[0].period.from} to{" "}
                        {t.answer.results[0].period.to} (end not included)
                      </span>
                    )}
                  </div>
                )}
                {t.answer.results.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted hover:text-foreground">
                      Show the data
                    </summary>
                    <ul className="mt-2 flex flex-col gap-2">
                      {t.answer.results.map((r, j) => (
                        <li key={j} className="rounded-md bg-background p-2">
                          <p className="font-medium">
                            {r.tool.replace(/_/g, " ")}
                          </p>
                          <p className="text-muted">{r.summary}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            )}
          </li>
        ))}
        {pending && (
          <li className="text-sm text-muted" role="status">
            Looking at your data…
          </li>
        )}
      </ol>
      <form
        className="sticky bottom-0 flex gap-2 border-t border-border bg-background py-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <label htmlFor="copilot-q" className="sr-only">
          Ask a question
        </label>
        <input
          id="copilot-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="Ask about members, renewals, revenue, dues, leads, classes…"
          className="h-11 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
        />
        <Button type="submit" disabled={pending || question.trim().length < 3}>
          Ask
        </Button>
      </form>
      <p className="text-xs text-muted">
        The Copilot reads only data you&apos;re allowed to see, quotes figures
        from your reports and can&apos;t change anything. Check important
        numbers in the linked reports.
      </p>
    </div>
  );
}
