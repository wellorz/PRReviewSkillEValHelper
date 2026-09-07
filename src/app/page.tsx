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
  status: string;
  status_message: string | null;
  scan_current: number;
  scan_total: number;
  collected_count: number;
  pr_count: number;
  human_finding_count: number;
  updated_at: string;
  latest_scan_status: string | null;
  latest_scan_scanned_count: number | null;
  latest_scan_skipped_count: number | null;
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

type Dashboard = {
  repositories: Repository[];
  runs: Run[];
  quickReviews: QuickReview[];
};

const EMPTY_DASHBOARD: Dashboard = {
  repositories: [],
  runs: [],
  quickReviews: [],
};

const BENCHMARK_FORM_STORAGE_KEY = "review-skill-lab:benchmark-form";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export default function Home() {
  const importPrSetInput = useRef<HTMLInputElement>(null);
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
      const value = JSON.parse(saved) as Partial<typeof form>;
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
  const collectionFilterLocked =
    busy === "repository" ||
    dashboard.repositories.some((repository) =>
      ["queued", "syncing"].includes(repository.status),
    );

  async function submitRepository(event: FormEvent) {
    event.preventDefault();
    setBusy("repository");
    setMessage(null);
    window.localStorage.setItem(
      BENCHMARK_FORM_STORAGE_KEY,
      JSON.stringify(form),
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
              disabled={!form.usePathFilter || collectionFilterLocked}
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

          <button className="primaryButton" disabled={busy === "repository"}>
            {busy === "repository" ? "Collecting…" : "Collect PR"}
          </button>
          <p className="prerequisite">
            Requires authenticated <code>gh</code> and <code>copilot</code> CLIs.
          </p>
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
                  <div className="miniStats">
                    <span><strong>{repository.pr_count}</strong> PRs</span>
                    <span><strong>{repository.human_finding_count}</strong> human findings</span>
                    <span><strong>{repository.target_prs}</strong> target</span>
                  </div>
                  {repository.latest_scan_started_at && (
                    <div className="scanCheckpoint">
                      <strong>
                        {repository.latest_scan_status === "running"
                          ? "Current scan checkpoint"
                          : "Latest scan checkpoint"}
                      </strong>
                      <span>
                        {repository.latest_scan_oldest_pr &&
                        repository.latest_scan_newest_pr
                          ? `PR #${repository.latest_scan_oldest_pr}–#${repository.latest_scan_newest_pr}`
                          : "No PR range recorded yet"}
                      </span>
                      <span>
                        {repository.latest_scan_oldest_date &&
                        repository.latest_scan_newest_date
                          ? `${formatDate(repository.latest_scan_oldest_date)} – ${formatDate(repository.latest_scan_newest_date)}`
                          : "No source-date range recorded yet"}
                      </span>
                      <span>
                        {repository.latest_scan_scanned_count ?? 0} inspected ·{" "}
                        {repository.latest_scan_skipped_count ?? 0} reused from
                        cache · {repository.latest_scan_policy_version}
                      </span>
                    </div>
                  )}
                  {(repository.status === "syncing" ||
                    repository.status === "queued" ||
                    repository.status === "failed") && (
                    <div className="datasetProgress">
                      <div className="progressLabel">
                        {repository.status === "queued" ? (
                          <>
                            <span>Collection queued</span>
                            <span>Not started</span>
                          </>
                        ) : (
                          <>
                            <span>
                              {repository.scan_current}/
                              {repository.scan_total || "?"} scanned
                            </span>
                            <span>{repository.collected_count} collected</span>
                          </>
                        )}
                      </div>
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
