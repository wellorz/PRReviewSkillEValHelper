"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { modelLabel } from "@/lib/models";
import { PageNavigation } from "@/app/page-navigation";
import { DEFAULT_CONFIRMATION_WORDS } from "@/lib/collection-policy";

type Repository = {
  id: number;
  slug: string;
  display_name: string;
  provider: string;
  path_filter: string | null;
  skill_path: string;
  model: string;
  model_secondary: string;
  context_tier: string;
  target_prs: number;
  pr_number_greater_than: number | null;
  pr_number_less_than: number | null;
  status: string;
  status_message: string | null;
  scan_current: number;
  scan_total: number;
  scan_current_prs: string | null;
  collected_count: number;
  pr_count: number;
  human_finding_count: number;
  pr_set_oldest_pr: number | null;
  pr_set_newest_pr: number | null;
  pr_set_oldest_date: string | null;
  pr_set_newest_date: string | null;
  pr_created_before: string | null;
  updated_at: string;
  latest_scan_status: string | null;
  latest_scan_scanned_count: number | null;
  latest_scan_skipped_count: number | null;
  latest_scan_eligible_count: number | null;
  latest_scan_failed_count: number | null;
  latest_scan_failed_prs_json: string | null;
  latest_scan_newest_pr: number | null;
  latest_scan_oldest_pr: number | null;
  latest_scan_newest_date: string | null;
  latest_scan_oldest_date: string | null;
  latest_scan_policy_version: string | null;
  latest_scan_started_at: string | null;
  latest_scan_completed_at: string | null;
};

type Run = {
  id: number;
  repository_id: number;
  slug: string;
  status: string;
  trigger: string;
  model: string;
  model_secondary: string;
  current_pr: number;
  total_prs: number;
  completed_prs: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  summary_path: string | null;
};

type QuickReview = {
  id: number;
  repository_id: number;
  slug: string;
  pr_number: number;
  title: string | null;
  status: string;
  stage: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  result_path: string | null;
};

type ManualPrTask = {
  id: number;
  repository_id: number;
  status: string;
  current_item: number;
  total_items: number;
  status_message: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type Dashboard = {
  repositories: Repository[];
  runs: Run[];
  quickReviews: QuickReview[];
  manualPrTasks: ManualPrTask[];
};

type ScreenshotScan = {
  repositoryId: string;
  fileNames: string[];
  fileResults: Array<{
    fileName: string;
    prNumbers: number[];
    confidence: number;
    error: string | null;
  }>;
  prNumbers: number[];
  existingPrNumbers: number[];
  selectedPrNumbers: number[];
  confidence: number;
};

const EMPTY_DASHBOARD: Dashboard = {
  repositories: [],
  runs: [],
  quickReviews: [],
  manualPrTasks: [],
};

const BENCHMARK_FORM_STORAGE_KEY = "review-skill-lab:benchmark-form";
const COMMENT_SELECTION_STORAGE_VERSION = 1;

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function parsePrNumberList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (number): number is number =>
            typeof number === "number" && Number.isInteger(number),
        )
      : [];
  } catch {
    return [];
  }
}

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export default function Home() {
  const importPrSetInput = useRef<HTMLInputElement>(null);
  const screenshotInput = useRef<HTMLInputElement>(null);
  const [dashboard, setDashboard] = useState<Dashboard>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    slug: "",
    targetPrs: 100,
    scanLimit: 2000,
    usePathFilter: false,
    pathFilter: "",
    collectionMode: "strict_confirmed" as
      | "strict_confirmed"
      | "resolved_comments",
    confirmationWords: [] as string[],
    prNumberGreaterThan: null as number | null,
    prNumberLessThan: null as number | null,
    prCreatedBefore: "",
  });
  const [confirmationInput, setConfirmationInput] = useState("");
  const [screenshotScan, setScreenshotScan] = useState<ScreenshotScan>({
    repositoryId: "",
    fileNames: [],
    fileResults: [],
    prNumbers: [],
    existingPrNumbers: [],
    selectedPrNumbers: [],
    confidence: 0,
  });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load dashboard");
      setDashboard((await response.json()) as Dashboard);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const saved = window.localStorage.getItem(BENCHMARK_FORM_STORAGE_KEY);
    if (!saved) return;
    try {
      const value = JSON.parse(saved) as Partial<typeof form> & {
        commentSelectionStorageVersion?: number;
      };
      const timer = window.setTimeout(
        () =>
          setForm((current) => ({
            slug: typeof value.slug === "string" ? value.slug : current.slug,
            targetPrs:
              typeof value.targetPrs === "number"
                ? value.targetPrs
                : current.targetPrs,
            scanLimit:
              typeof value.scanLimit === "number"
                ? value.scanLimit
                : current.scanLimit,
            usePathFilter:
              typeof value.usePathFilter === "boolean"
                ? value.usePathFilter
                : typeof value.pathFilter === "string" &&
                  value.pathFilter.trim().length > 0,
            pathFilter:
              typeof value.pathFilter === "string"
                ? value.pathFilter
                : current.pathFilter,
            collectionMode:
              value.commentSelectionStorageVersion ===
                COMMENT_SELECTION_STORAGE_VERSION &&
              value.collectionMode === "resolved_comments"
                ? "resolved_comments"
                : "strict_confirmed",
            confirmationWords: Array.isArray(value.confirmationWords)
              ? value.confirmationWords.filter(
                  (word): word is string =>
                    typeof word === "string" && Boolean(word.trim()),
                )
              : [],
            prNumberGreaterThan:
              typeof value.prNumberGreaterThan === "number"
                ? value.prNumberGreaterThan
                : null,
            prNumberLessThan:
              typeof value.prNumberLessThan === "number"
                ? value.prNumberLessThan
                : null,
            prCreatedBefore:
              typeof value.prCreatedBefore === "string"
                ? value.prCreatedBefore
                : "",
          })),
        0,
      );
      return () => window.clearTimeout(timer);
    } catch {
      window.localStorage.removeItem(BENCHMARK_FORM_STORAGE_KEY);
    }
  }, []);

  const activeRuns = useMemo(
    () =>
      dashboard.runs.filter((run) =>
        ["queued", "running"].includes(run.status),
      ).length +
      dashboard.quickReviews.filter((review) =>
        ["queued", "running"].includes(review.status),
      ).length,
    [dashboard.quickReviews, dashboard.runs],
  );
  const totalPrs = dashboard.repositories.reduce(
    (sum, repository) => sum + Number(repository.pr_count),
    0,
  );
  const totalHumanFindings = dashboard.repositories.reduce(
    (sum, repository) => sum + Number(repository.human_finding_count),
    0,
  );
  const navigationRepository = dashboard.repositories[0];
  const latestManualPrTask = navigationRepository
    ? (dashboard.manualPrTasks ?? []).find(
        (task) =>
          task.repository_id === navigationRepository.id &&
          task.status !== "completed",
      )
    : undefined;
  const repositoryCollectionActive = dashboard.repositories.some(
    (repository) => ["queued", "syncing"].includes(repository.status),
  );
  const collectionFilterLocked =
    busy === "repository" || repositoryCollectionActive;

  async function submitRepository(event: FormEvent) {
    event.preventDefault();
    setBusy("repository");
    setMessage(null);
    window.localStorage.setItem(
      BENCHMARK_FORM_STORAGE_KEY,
      JSON.stringify({
        ...form,
        commentSelectionStorageVersion: COMMENT_SELECTION_STORAGE_VERSION,
      }),
    );
    try {
      await request("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setMessage("Repository queued. The worker will build its dataset.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function addConfirmationWord() {
    const word = confirmationInput.trim();
    if (!word) return;
    setForm((current) => {
      const existing = [
        ...DEFAULT_CONFIRMATION_WORDS,
        ...current.confirmationWords,
      ];
      if (
        existing.some(
          (candidate) =>
            candidate.toLocaleLowerCase() === word.toLocaleLowerCase(),
        )
      ) {
        return current;
      }
      return {
        ...current,
        confirmationWords: [...current.confirmationWords, word],
      };
    });
    setConfirmationInput("");
  }

  async function cancelRepositoryCollection(repositoryId: number) {
    setBusy(`cancel-collection-${repositoryId}`);
    setMessage(null);
    try {
      await request(`/api/repositories/${repositoryId}/cancel-collection`, {
        method: "POST",
      });
      setMessage("PR collection cancellation requested.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancelManualPrCollection(task: ManualPrTask) {
    setBusy(`cancel-manual-pr-${task.id}`);
    setMessage(null);
    try {
      await request(
        `/api/repositories/${task.repository_id}/workflow-tasks/${task.id}/cancel`,
        { method: "POST" },
      );
      setMessage("Candidate PR collection cancellation requested.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function importPrSet(file: File) {
    setBusy("import-pr-set");
    setMessage(null);
    try {
      const response = await fetch("/api/pr-sets/import", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const body = (await response.json()) as {
        error?: string;
        repositories?: number;
        pullRequests?: number;
      };
      if (!response.ok) throw new Error(body.error ?? "PR-set import failed");
      setMessage(
        `Imported ${body.pullRequests ?? 0} PRs across ${body.repositories ?? 0} PR set${body.repositories === 1 ? "" : "s"}.`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      if (importPrSetInput.current) importPrSetInput.current.value = "";
    }
  }

  async function scanPrScreenshots(files: File[]) {
      if (!navigationRepository) {
        setMessage("Configure a repository before scanning screenshots.");
        return;
      }
      setBusy("scan-pr-screenshot");
      setMessage(null);
      try {
        const formData = new FormData();
        for (const file of files) formData.append("images", file);
        const response = await fetch(
          `/api/repositories/${navigationRepository.id}/screenshot-prs`,
          {
            method: "POST",
            body: formData,
          },
        );
        const body = (await response.json()) as {
          error?: string;
          prNumbers?: number[];
          existingPrNumbers?: number[];
          confidence?: number;
          fileResults?: ScreenshotScan["fileResults"];
        };
        if (!response.ok) {
          throw new Error(body.error ?? "Screenshot OCR failed");
        }
        const prNumbers = body.prNumbers ?? [];
        const existingPrNumbers = body.existingPrNumbers ?? [];
        const existing = new Set(existingPrNumbers);
        const newPrNumbers = prNumbers.filter((number) => !existing.has(number));
        setScreenshotScan((current) => ({
          ...current,
          repositoryId: String(navigationRepository.id),
          fileNames: files.map((file) => file.name),
          fileResults: body.fileResults ?? [],
          prNumbers,
          existingPrNumbers,
          selectedPrNumbers:
            newPrNumbers.length > 0 ? newPrNumbers : prNumbers,
          confidence: body.confidence ?? 0,
        }));
        setMessage(
          `Found ${prNumbers.length} explicit PR number${
            prNumbers.length === 1 ? "" : "s"
          } across ${files.length} screenshot${
            files.length === 1 ? "" : "s"
          }. Review the selection before collecting.`,
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
        if (screenshotInput.current) screenshotInput.current.value = "";
      }
    }

  async function collectScreenshotPrs() {
    if (
      !screenshotScan.repositoryId ||
      screenshotScan.selectedPrNumbers.length === 0
    ) {
      return;
    }
    setBusy("collect-screenshot-prs");
    setMessage(null);
    try {
      const response = await fetch(
        `/api/repositories/${screenshotScan.repositoryId}/manual-pr`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            values: screenshotScan.selectedPrNumbers.map(String),
            requireValuedComments: true,
          }),
        },
      );
      const body = (await response.json()) as {
        error?: string;
        taskIds?: number[];
        prNumbers?: number[];
        concurrency?: number;
      };
      if (!response.ok) {
        throw new Error(body.error ?? "Unable to queue screenshot PRs");
      }
      const count =
        body.prNumbers?.length ?? screenshotScan.selectedPrNumbers.length;
      setMessage(
        `Queued ${count} PR candidate${
          count === 1 ? "" : "s"
        } with up to ${body.concurrency ?? 5} concurrent checks. Only eligible PRs with owner-confirmed valued findings will be added.`,
      );
      setScreenshotScan((current) => ({
        ...current,
        fileNames: [],
        fileResults: [],
        prNumbers: [],
        existingPrNumbers: [],
        selectedPrNumbers: [],
        confidence: 0,
      }));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brandMark">PR</span>
          <div>
            <strong>Review Skill Lab</strong>
            <span>Blind, paired evaluation for Copilot review skills</span>
          </div>
        </div>
        <div className="workerHint">
          <span className={activeRuns ? "pulseDot active" : "pulseDot"} />
          {activeRuns ? `${activeRuns} job${activeRuns > 1 ? "s" : ""} active` : "Worker idle"}
        </div>
      </header>

      {navigationRepository && (
        <PageNavigation
          previous={{
            href: `/repositories/${navigationRepository.id}/history-reports`,
            label: "History Reports",
          }}
          next={{
            href: `/repositories/${navigationRepository.id}/pr-set-view`,
            label: "PR Set View",
          }}
        />
      )}

      <section className="hero">
        <div>
          <span className="eyebrow">Evaluation workspace</span>
          <h1>Measure whether a review skill actually finds more defects.</h1>
          <p>
            Build a ground-truth dataset from valued human comments, run blind
            skilled and baseline reviews with the same model, then compare
            recall, precision, F1, and time.
          </p>
        </div>
        <div className="heroStats">
          <div><strong>{dashboard.repositories.length}</strong><span>Repositories</span></div>
          <div><strong>{totalPrs}</strong><span>PR quizzes</span></div>
          <div><strong>{totalHumanFindings}</strong><span>Human findings</span></div>
        </div>
      </section>

      {message && <div className="notice">{message}</div>}

      <section className="workspaceGrid">
        <form className="panel setupPanel" onSubmit={submitRepository}>
          <div className="panelHeading">
            <div>
              <span className="step">01</span>
              <h2>Configure benchmark</h2>
            </div>
            <span className="badge">Local</span>
          </div>

          <label>
            Repository
            <input
              required
              placeholder="owner/repository or Azure DevOps repository URL"
              value={form.slug}
              onChange={(event) =>
                setForm((current) => ({ ...current, slug: event.target.value }))
              }
            />
            <small>
              Azure DevOps URLs may include a path query, which becomes the
              changed-folder filter automatically.
            </small>
          </label>

          <div className="pathFilterField">
            <label className="checkboxLabel">
              <input
                type="checkbox"
                checked={form.usePathFilter}
                disabled={collectionFilterLocked}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    usePathFilter: event.target.checked,
                  }))
                }
              />
              <span>PR Path Filter</span>
            </label>
            <input
              placeholder="sources/dev/Management/src/ServiceHost/Servicelets"
              disabled={form.usePathFilter || collectionFilterLocked}
              value={form.pathFilter}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  pathFilter: event.target.value,
                }))
              }
            />
            <small>
              Limits this dataset collection to PRs changing any listed folder
              prefix. Separate folders with commas. This is independent from
              the Review Details filter.
            </small>
          </div>

          <fieldset className="collectionMethodField">
            <legend>Comment selection method</legend>
            <div className="collectionMethodOptions">
              <label
                className={`collectionMethodOption${form.collectionMode === "strict_confirmed" ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="collectionMode"
                  checked={form.collectionMode === "strict_confirmed"}
                  disabled={collectionFilterLocked}
                  onChange={() => {
                    setForm((current) => ({
                      ...current,
                      collectionMode: "strict_confirmed",
                    }));
                  }}
                />
                <span>
                  <strong>Strictly confirmed comments</strong>
                  <small>
                    Keep the current owner-confirmed collection behavior and
                    assign SelectLevel 1.
                  </small>
                </span>
              </label>
              <label
                className={`collectionMethodOption${form.collectionMode === "resolved_comments" ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="collectionMode"
                  checked={form.collectionMode === "resolved_comments"}
                  disabled={collectionFilterLocked}
                  onChange={() => {
                    setForm((current) => ({
                      ...current,
                      collectionMode: "resolved_comments",
                    }));
                  }}
                />
                <span>
                  <strong>All resolved comments</strong>
                  <small>
                    Collect substantive resolved Azure DevOps threads, excluding
                    active, pending, and won&apos;t-fix dispositions.
                  </small>
                </span>
              </label>
            </div>

            <div
              className={`confirmationWords${form.collectionMode !== "strict_confirmed" ? " disabled" : ""}`}
            >
              <span className="fieldLabel">Confirmations</span>
              <div className="confirmationWordList">
                {DEFAULT_CONFIRMATION_WORDS.map((word) => (
                  <span className="confirmationWord default" key={word}>
                    {word}
                  </span>
                ))}
                {form.confirmationWords.map((word) => (
                  <span className="confirmationWord custom" key={word}>
                    {word}
                    <button
                      type="button"
                      aria-label={`Remove confirmation ${word}`}
                      disabled={
                        collectionFilterLocked ||
                        form.collectionMode !== "strict_confirmed"
                      }
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          confirmationWords:
                            current.confirmationWords.filter(
                              (candidate) => candidate !== word,
                            ),
                        }))
                      }
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
              <div className="confirmationWordInput">
                <input
                  value={confirmationInput}
                  placeholder="Add a confirmation word or phrase"
                  disabled={
                    collectionFilterLocked ||
                    form.collectionMode !== "strict_confirmed"
                  }
                  onChange={(event) =>
                    setConfirmationInput(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addConfirmationWord();
                  }}
                />
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={
                    collectionFilterLocked ||
                    form.collectionMode !== "strict_confirmed" ||
                    !confirmationInput.trim()
                  }
                  onClick={addConfirmationWord}
                >
                  Add
                </button>
              </div>
            </div>
          </fieldset>

          <label>
            PR created on or before
            <input
              type="date"
              value={form.prCreatedBefore}
              disabled={collectionFilterLocked}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  prCreatedBefore: event.target.value,
                }))
              }
            />
            <small>
              Inclusive creation-date cutoff. Leave empty to scan all dates.
            </small>
          </label>

          <div className="prNumberRangeField">
            <div className="fieldLabel">
              PR Num Range
              <span
                className="helpTooltip"
                tabIndex={0}
                aria-label="PR number range help"
              >
                *
                <span role="tooltip">
                  Optional exclusive bounds. Leave both empty for no PR-number
                  filter. A left value keeps PR numbers greater than it; a
                  right value keeps PR numbers smaller than it. Existing PRs
                  already in the set are preserved.
                </span>
              </span>
            </div>
            <div className="prNumberRangeInputs">
              <input
                type="number"
                min={1}
                placeholder="Greater than"
                aria-label="PR number greater than"
                value={form.prNumberGreaterThan ?? ""}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    prNumberGreaterThan:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
              <span>–</span>
              <input
                type="number"
                min={1}
                placeholder="Less than"
                aria-label="PR number less than"
                value={form.prNumberLessThan ?? ""}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    prNumberLessThan:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
            </div>
          </div>

          <div className="fieldRow">
            <label>
              Eligible PRs
              <input
                type="number"
                min={1}
                max={100}
                value={form.targetPrs}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    targetPrs: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Search safety limit
              <input
                type="number"
                min={1}
                max={10000}
                value={form.scanLimit}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    scanLimit: Number(event.target.value),
                  }))
                }
              />
              <small>
                Recent PRs to inspect, not PRs added. Collection stops after
                the eligible PR target is reached.
              </small>
            </label>
          </div>

          <button className="primaryButton" disabled={collectionFilterLocked}>
            {busy === "repository"
              ? "Queuing…"
              : repositoryCollectionActive
                ? "Collecting…"
                : "Collect PR"}
          </button>
          <p className="prerequisite">
            Requires authenticated <code>gh</code> and <code>copilot</code> CLIs.
          </p>

          <div className="screenshotImportSection">
            <div className="screenshotImportTitle">
              <strong>Collect PRs from screenshot</strong>
              <span className="badge">Local OCR</span>
            </div>
            <p className="screenshotImportDescription">
              Upload up to 10 screenshots containing entries such as{" "}
              <code>Merged PR 5606853</code>. PRs are collected into{" "}
              <strong>
                {navigationRepository
                  ? navigationRepository.display_name ||
                    navigationRepository.slug
                  : "the configured repository"}
              </strong>
              . Commit and task IDs are ignored.
            </p>
            <button
              type="button"
              className="secondaryButton screenshotUploadButton"
              disabled={
                !navigationRepository || busy === "scan-pr-screenshot"
              }
              onClick={() => screenshotInput.current?.click()}
            >
              {busy === "scan-pr-screenshot"
                ? "Reading screenshots…"
                : "Upload screenshots"}
            </button>
            <input
              ref={screenshotInput}
              className="visuallyHidden"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void scanPrScreenshots(files);
              }}
            />

            {latestManualPrTask && (
              <div
                className={`screenshotTaskProgress status-${latestManualPrTask.status}`}
              >
                <div className="progressLabel">
                  <strong>{latestManualPrTask.status_message}</strong>
                  <span>
                    {latestManualPrTask.current_item}/
                    {latestManualPrTask.total_items || "?"}
                  </span>
                </div>
                {["queued", "running", "cancelling"].includes(
                  latestManualPrTask.status,
                ) && (
                  <div className="progressTrack">
                    <span
                      style={{
                        width: latestManualPrTask.total_items
                          ? `${Math.min(
                              100,
                              (latestManualPrTask.current_item /
                                latestManualPrTask.total_items) *
                                100,
                            )}%`
                          : "3%",
                      }}
                    />
                  </div>
                )}
                {["queued", "running", "cancelling"].includes(
                  latestManualPrTask.status,
                ) && (
                  <button
                    type="button"
                    className="dangerButton collectionCancelButton"
                    disabled={
                      latestManualPrTask.status === "cancelling" ||
                      busy === `cancel-manual-pr-${latestManualPrTask.id}`
                    }
                    onClick={() =>
                      void cancelManualPrCollection(latestManualPrTask)
                    }
                  >
                    {latestManualPrTask.status === "cancelling" ||
                    busy === `cancel-manual-pr-${latestManualPrTask.id}`
                      ? "Cancelling…"
                      : "Cancel collection"}
                  </button>
                )}
              </div>
            )}

            {screenshotScan.prNumbers.length > 0 && (
              <div className="screenshotPreview">
                <div className="screenshotPreviewHeading">
                  <div>
                    <strong>
                      {screenshotScan.fileNames.length} screenshot
                      {screenshotScan.fileNames.length === 1 ? "" : "s"} scanned
                    </strong>
                    <span>
                      {screenshotScan.prNumbers.length} PR candidates detected · OCR
                      confidence {screenshotScan.confidence.toFixed(0)}%
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondaryButton compact"
                    onClick={() =>
                      setScreenshotScan((current) => ({
                        ...current,
                        selectedPrNumbers:
                          current.selectedPrNumbers.length ===
                          current.prNumbers.length
                            ? []
                            : current.prNumbers,
                      }))
                    }
                  >
                    {screenshotScan.selectedPrNumbers.length ===
                    screenshotScan.prNumbers.length
                      ? "Clear all"
                      : "Select all"}
                  </button>
                </div>
                <div className="screenshotFileResults">
                  {screenshotScan.fileResults.map((result) => (
                    <div
                      className={result.error ? "hasError" : ""}
                      key={result.fileName}
                    >
                      <span>{result.fileName}</span>
                      <em>
                        {result.error ??
                          `${result.prNumbers.length} PR${
                            result.prNumbers.length === 1 ? "" : "s"
                          } · ${result.confidence.toFixed(0)}%`}
                      </em>
                    </div>
                  ))}
                </div>
                <div className="screenshotPrGrid">
                  {screenshotScan.prNumbers.map((number) => {
                    const checked =
                      screenshotScan.selectedPrNumbers.includes(number);
                    const existing =
                      screenshotScan.existingPrNumbers.includes(number);
                    return (
                      <label className="screenshotPrOption" key={number}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            setScreenshotScan((current) => ({
                              ...current,
                              selectedPrNumbers: event.target.checked
                                ? [...current.selectedPrNumbers, number]
                                : current.selectedPrNumbers.filter(
                                    (value) => value !== number,
                                  ),
                            }))
                          }
                        />
                        <span>#{number}</span>
                        {existing && <em>already collected</em>}
                      </label>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="primaryButton"
                  disabled={
                    screenshotScan.selectedPrNumbers.length === 0 ||
                    busy === "collect-screenshot-prs"
                  }
                  onClick={() => void collectScreenshotPrs()}
                >
                  {busy === "collect-screenshot-prs"
                    ? "Queuing…"
                    : `Check ${
                        screenshotScan.selectedPrNumbers.length
                      } selected PR candidate${
                        screenshotScan.selectedPrNumbers.length === 1
                          ? ""
                          : "s"
                      }`}
                </button>
              </div>
            )}
          </div>
        </form>

        <section className="panel repositoriesPanel">
          <div className="panelHeading">
            <div>
              <span className="step">02</span>
              <h2>PR Sets</h2>
            </div>
            <div className="prSetTransferActions">
              <span className="muted">
                {dashboard.repositories.length} configured
              </span>
              {dashboard.repositories[0] ? (
                <a
                  className="primaryButton compact actionLink"
                  href={`/repositories/${dashboard.repositories[0].id}/pr-set-view`}
                >
                  View PR sets
                </a>
              ) : (
                <button
                  type="button"
                  className="primaryButton compact"
                  disabled
                >
                  View PR sets
                </button>
              )}
              {dashboard.repositories.length === 0 ? (
                <button
                  type="button"
                  className="primaryButton compact"
                  disabled
                >
                  Export
                </button>
              ) : (
                <a
                  className="primaryButton compact actionLink"
                  href="/api/pr-sets/export"
                >
                  Export
                </a>
              )}
              <button
                type="button"
                className="primaryButton compact"
                disabled={busy === "import-pr-set"}
                onClick={() => importPrSetInput.current?.click()}
              >
                {busy === "import-pr-set" ? "Importing…" : "Import"}
              </button>
              <input
                ref={importPrSetInput}
                className="visuallyHidden"
                type="file"
                accept=".gz,.json,application/gzip,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importPrSet(file);
                }}
              />
            </div>
          </div>

          <div className="repositoryList">
            {loading && <div className="emptyState">Loading workspace…</div>}
            {!loading && dashboard.repositories.length === 0 && (
              <div className="emptyState">
                <strong>No benchmark yet</strong>
                <span>Add a repository to collect valued human review comments.</span>
              </div>
            )}
            {dashboard.repositories.map((repository) => {
              return (
                <article className="repositoryCard" key={repository.id}>
                  <div className="repositoryTitle">
                    <div>
                      <strong>{repository.display_name || repository.slug}</strong>
                      <span>
                        {repository.provider} · {modelLabel(repository.model)} +{" "}
                        {modelLabel(repository.model_secondary)} ·{" "}
                        {repository.context_tier === "long_context" ? "1M" : "400K"}
                      </span>
                    </div>
                    <span className={`status status-${repository.status}`}>
                      {repository.status}
                    </span>
                  </div>
                  {repository.status !== "failed" && (
                    <p>{repository.status_message ?? "Ready"}</p>
                  )}
                  {repository.status === "failed" && (
                    <details className="failureDetails" open>
                      <summary>Failure details</summary>
                      <pre>{repository.status_message ?? "Unknown worker failure"}</pre>
                    </details>
                  )}
                  {repository.path_filter && (
                    <p className="pathFilter">
                      Changes under <code>{repository.path_filter}</code>
                    </p>
                  )}
                  {(repository.pr_number_greater_than != null ||
                    repository.pr_number_less_than != null) && (
                    <p className="pathFilter">
                      PR numbers{" "}
                      <code>
                        {repository.pr_number_greater_than != null
                          ? `> ${repository.pr_number_greater_than}`
                          : "without lower bound"}
                        {" · "}
                        {repository.pr_number_less_than != null
                          ? `< ${repository.pr_number_less_than}`
                          : "without upper bound"}
                      </code>
                    </p>
                  )}
                  <div className="miniStats">
                    <span><strong>{repository.pr_count}</strong> PRs</span>
                    <span><strong>{repository.human_finding_count}</strong> human findings</span>
                    <span><strong>{repository.target_prs}</strong> target</span>
                  </div>
                  {repository.pr_set_oldest_pr &&
                    repository.pr_set_newest_pr && (
                    <div className="scanCheckpoint">
                      <strong>Current PR set checkpoint</strong>
                      <span>
                        PR #{repository.pr_set_oldest_pr}–#
                        {repository.pr_set_newest_pr}
                      </span>
                      <span>
                        {repository.pr_set_oldest_date &&
                        repository.pr_set_newest_date
                          ? `${formatDate(repository.pr_set_oldest_date)} – ${formatDate(repository.pr_set_newest_date)}`
                          : "No source-date range recorded yet"}
                      </span>
                      {repository.latest_scan_started_at && (
                        <>
                          <span>
                            Last full scan:{" "}
                            {repository.latest_scan_scanned_count ?? 0} inspected ·{" "}
                            {repository.latest_scan_skipped_count ?? 0} reused
                            from cache ·{" "}
                            {repository.latest_scan_eligible_count ?? 0} collected
                            {" · "}
                            {repository.latest_scan_policy_version}
                          </span>
                          {(repository.latest_scan_failed_count ?? 0) > 0 && (
                            <span className="scanFailureSummary">
                              Git failures after three retries:{" "}
                              {parsePrNumberList(
                                repository.latest_scan_failed_prs_json,
                              )
                                .map((number) => `#${number}`)
                                .join(", ")}
                            </span>
                          )}
                          {repository.latest_scan_oldest_pr != null &&
                            repository.latest_scan_newest_pr != null && (
                              <span>
                                Scan coverage: PR #
                                {repository.latest_scan_oldest_pr}–#
                                {repository.latest_scan_newest_pr}
                              </span>
                            )}
                          {repository.latest_scan_oldest_date &&
                            repository.latest_scan_newest_date && (
                              <span>
                                Scan source dates:{" "}
                                {formatDate(repository.latest_scan_oldest_date)} –{" "}
                                {formatDate(repository.latest_scan_newest_date)}
                              </span>
                            )}
                          {repository.latest_scan_oldest_pr != null &&
                            repository.latest_scan_newest_pr != null && (
                              <div className="scanRangeActions">
                                <span>Continue with a non-overlapping range:</span>
                                <button
                                  type="button"
                                  className="secondaryButton compact"
                                  onClick={() =>
                                    setForm((current) => ({
                                      ...current,
                                      prNumberGreaterThan: null,
                                      prNumberLessThan:
                                        repository.latest_scan_oldest_pr,
                                    }))
                                  }
                                >
                                  Next older: &lt; #
                                  {repository.latest_scan_oldest_pr}
                                </button>
                                <button
                                  type="button"
                                  className="secondaryButton compact"
                                  onClick={() =>
                                    setForm((current) => ({
                                      ...current,
                                      prNumberGreaterThan:
                                        repository.latest_scan_newest_pr,
                                      prNumberLessThan: null,
                                    }))
                                  }
                                >
                                  Next newer: &gt; #
                                  {repository.latest_scan_newest_pr}
                                </button>
                              </div>
                            )}
                        </>
                      )}
                    </div>
                  )}
                  {(repository.status === "syncing" ||
                    repository.status === "queued" ||
                    repository.status === "cancelling" ||
                    repository.status === "cancelled" ||
                    repository.status === "failed") && (
                    <div className="datasetProgress">
                      <div className="progressLabel">
                        {repository.status === "queued" ? (
                          <>
                            <span>Collection queued</span>
                            <span>Not started</span>
                          </>
                        ) : repository.status === "cancelled" ? (
                          <>
                            <span>Collection cancelled</span>
                            <span>
                              {repository.scan_current}/
                              {repository.scan_total || "?"} scanned
                            </span>
                          </>
                        ) : (
                          <>
                            <span>
                              {repository.scan_current}/
                              {repository.scan_total || "?"} scanned
                            </span>
                          </>
                        )}
                      </div>
                      {repository.scan_current_prs && (
                        <div className="scanCurrentPrs">
                          {repository.status === "syncing" ||
                          repository.status === "cancelling"
                            ? "Currently scanning"
                            : "Last scanned"}
                          : {repository.scan_current_prs}
                        </div>
                      )}
                      <div className="progressTrack">
                        <span
                          style={{
                            width: repository.scan_total
                              ? `${Math.min(
                                  100,
                                  (repository.scan_current /
                                    repository.scan_total) *
                                    100,
                                )}%`
                              : "0%",
                          }}
                        />
                      </div>
                      {["queued", "syncing", "cancelling"].includes(
                        repository.status,
                      ) && (
                        <button
                          type="button"
                          className="dangerButton collectionCancelButton"
                          disabled={
                            repository.status === "cancelling" ||
                            busy === `cancel-collection-${repository.id}`
                          }
                          onClick={() =>
                            void cancelRepositoryCollection(repository.id)
                          }
                        >
                          {repository.status === "cancelling" ||
                          busy === `cancel-collection-${repository.id}`
                            ? "Cancelling…"
                            : "Cancel collection"}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </section>

      <footer>
        Ground truth stays outside model-visible workspaces. Review order is
        randomized per PR to reduce ordering bias.
      </footer>
    </main>
  );
}
