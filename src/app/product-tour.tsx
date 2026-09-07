"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const TOUR_STEPS = [
  {
    title: "Dashboard",
    eyebrow: "Configure and run",
    description:
      "Choose the local repository and branch, configure baseline profiles and personal skills, select PRs, and monitor live review progress.",
    action: "Open dashboard",
  },
  {
    title: "PR Set View",
    eyebrow: "Inspect credited defects",
    description:
      "Review every collected PR and the exact owner-confirmed or manually added defects that currently receive benchmark credit.",
    action: "Open PR Set View",
  },
  {
    title: "HistoryReports",
    eyebrow: "Save immutable snapshots",
    description:
      "Use Save report on the dashboard when you want to preserve the current result matrix. HistoryReports lists those manually saved, timestamped snapshots.",
    action: "Open HistoryReports",
  },
  {
    title: "Review details",
    eyebrow: "Inspect each result",
    description:
      "Open the repository review workspace to inspect each PR's live score, elapsed time, findings, errors, and detailed review output.",
    action: "Open Review Details",
  },
] as const;

function repositoryId(pathname: string) {
  return pathname.match(/^\/repositories\/(\d+)/)?.[1] ?? null;
}

export function ProductTour() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [latestRepositoryId, setLatestRepositoryId] = useState<string | null>(
    null,
  );
  const step = TOUR_STEPS[stepIndex];
  const repoId = repositoryId(pathname);
  const navigationRepositoryId = repoId ?? latestRepositoryId;

  const stepHref = useMemo(() => {
    if (stepIndex === 0) {
      return "/";
    }
    if (stepIndex === 1) {
      return navigationRepositoryId
        ? `/repositories/${navigationRepositoryId}/pr-set-view`
        : "/";
    }
    if (stepIndex === 2) {
      return navigationRepositoryId
        ? `/repositories/${navigationRepositoryId}/history-reports`
        : "/";
    }
    if (stepIndex === 3) {
      return navigationRepositoryId
        ? `/repositories/${navigationRepositoryId}`
        : "/";
    }
    return "/";
  }, [
    navigationRepositoryId,
    pathname,
    stepIndex,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function loadNavigationTargets() {
      let targetRepositoryId = repoId;
      if (!targetRepositoryId) {
        const dashboardResponse = await fetch("/api/dashboard", {
          cache: "no-store",
        });
        if (dashboardResponse.ok) {
          const dashboard = (await dashboardResponse.json()) as {
            repositories?: Array<{ id: number }>;
          };
          targetRepositoryId = dashboard.repositories?.[0]?.id
            ? String(dashboard.repositories[0].id)
            : null;
        }
      }
      if (cancelled) return;
      setLatestRepositoryId(targetRepositoryId);
    }
    void loadNavigationTargets();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button
        className="tourLauncher"
        type="button"
        aria-label="Open product tour"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      {open && (
        <div
          className="tourBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <section
            className="tourDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tour-title"
          >
            <div className="tourDialogHeader">
              <div>
                <span className="eyebrow">{step.eyebrow}</span>
                <h2 id="tour-title">{step.title}</h2>
              </div>
              <button
                className="tourClose"
                type="button"
                aria-label="Close product tour"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <p>{step.description}</p>
            <div className="tourStepList" aria-label="Tour progress">
              {TOUR_STEPS.map((candidate, index) => (
                <button
                  key={candidate.title}
                  type="button"
                  className={index === stepIndex ? "active" : ""}
                  aria-label={`Show ${candidate.title}`}
                  onClick={() => setStepIndex(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <div className="tourActions">
              <button
                className="secondaryButton"
                type="button"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((index) => index - 1)}
              >
                Previous
              </button>
              <div>
                <Link
                  className="tourPageLink"
                  href={stepHref}
                  onClick={() => setOpen(false)}
                >
                  {step.action}
                </Link>
                {stepIndex < TOUR_STEPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => setStepIndex((index) => index + 1)}
                  >
                    Next
                  </button>
                ) : (
                  <button type="button" onClick={() => setOpen(false)}>
                    Done
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
