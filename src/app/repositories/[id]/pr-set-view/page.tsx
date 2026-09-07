"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PageNavigation } from "@/app/page-navigation";
import { PrTableControls } from "@/app/pr-table-controls";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type Defect = {
  id: string;
  body: string;
  originalBody: string;
  path: string | null;
  line: number | null;
  author: string;
  manual: boolean;
};

type PullRequest = {
  id: number;
  number: number;
  title: string;
  url: string;
  author: string;
  changedFiles: number;
  defects: Defect[];
};

type PrSet = {
  repository: {
    id: number;
    displayName: string;
    slug: string;
  };
  pullRequests: PullRequest[];
};

export default function PrSetViewPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<PrSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defectModal, setDefectModal] = useState<{
    prId: number;
    mode: "view" | "edit";
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [manualPr, setManualPr] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [prSearch, setPrSearch] = useState("");
  const [pageSizeInput, setPageSizeInput] = useState("20");
  const [currentPage, setCurrentPage] = useState(1);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/repositories/${id}/pr-set`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load PR set");
      setData(body as PrSet);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 3000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (!defectModal) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDefectModal(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [defectModal]);

  async function addManualPr(event: FormEvent) {
    event.preventDefault();
    setBusy("manual");
    setMessage(null);
    try {
      const response = await fetch(`/api/repositories/${id}/manual-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: manualPr }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to add PR");
      setManualPr("");
      setMessage("PR import queued. This page will update automatically.");
      await load();
    } catch (addError) {
      setMessage(
        addError instanceof Error ? addError.message : String(addError),
      );
    } finally {
      setBusy(null);
    }
  }

  function startEditing(pr: PullRequest) {
    setDrafts(
      pr.defects.length > 0
        ? Object.fromEntries(
            pr.defects.map((defect) => [defect.id, defect.body]),
          )
        : { [`manual-defect-${pr.id}`]: "" },
    );
    setDefectModal({ prId: pr.id, mode: "edit" });
  }

  async function saveDefects(pr: PullRequest) {
    setBusy(`save-${pr.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/pull-requests/${pr.id}/defects`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defects:
            pr.defects.length > 0
              ? pr.defects.map((defect) => ({
                  id: defect.id,
                  normalizedBody: drafts[defect.id] ?? defect.body,
                }))
              : [
                  {
                    id: `manual-defect-${pr.id}`,
                    normalizedBody: drafts[`manual-defect-${pr.id}`] ?? "",
                  },
                ],
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to save defects");
      setDefectModal(null);
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setBusy(null);
    }
  }

  async function deletePullRequest(pr: PullRequest) {
    if (!window.confirm(`Delete PR #${pr.number} from this dataset?`)) return;
    if (
      !window.confirm(
        `Confirm deletion of PR #${pr.number}. This is the final confirmation.`,
      )
    ) {
      return;
    }
    setBusy(`delete-${pr.id}`);
    setError(null);
    try {
      const response = await fetch(`/api/pull-requests/${pr.id}`, {
        method: "DELETE",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to delete PR");
      if (defectModal?.prId === pr.id) setDefectModal(null);
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : String(deleteError),
      );
    } finally {
      setBusy(null);
    }
  }

  const pageSize = Math.min(
    500,
    Math.max(1, Number.parseInt(pageSizeInput, 10) || 20),
  );
  const filteredPullRequests = useMemo(() => {
    const query = prSearch.trim().replace(/^#/, "");
    const pullRequests = data?.pullRequests ?? [];
    if (!query) return pullRequests;
    return pullRequests.filter((pr) =>
      String(pr.number).includes(query),
    );
  }, [data, prSearch]);
  const pageCount = Math.max(
    1,
    Math.ceil(filteredPullRequests.length / pageSize),
  );
  const displayedPage = Math.min(currentPage, pageCount);
  const paginatedPullRequests = useMemo(() => {
    const start = (displayedPage - 1) * pageSize;
    return filteredPullRequests.slice(start, start + pageSize);
  }, [displayedPage, filteredPullRequests, pageSize]);

  if (!data) {
    return (
      <main className="prWorkspace">
        <PageNavigation
          previous={{ href: "/", label: "Dashboard" }}
          next={{ href: `/repositories/${id}`, label: "Review Details" }}
        />
        <div className="panel loadingPanel">{error ?? "Loading PR set…"}</div>
      </main>
    );
  }

  const creditedDefects = data.pullRequests.reduce(
    (total, pr) => total + pr.defects.length,
    0,
  );
  const modalPr = defectModal
    ? data.pullRequests.find((pr) => pr.id === defectModal.prId) ?? null
    : null;

  return (
    <main className="prWorkspace">
      <PageNavigation
        previous={{ href: "/", label: "Dashboard" }}
        next={{ href: `/repositories/${id}`, label: "Review Details" }}
      />
      <header className="workspaceHeader">
        <div>
          <span className="eyebrow">Scored benchmark ground truth</span>
          <h1>PR Set View</h1>
          <p>
            {data.repository.displayName || data.repository.slug} · Only the
            defects that currently receive benchmark credit are listed.
          </p>
        </div>
        <div className="selectionCount">
          <strong>{data.pullRequests.length}</strong>
          <span>{creditedDefects} credited defects</span>
        </div>
      </header>

      {error && <div className="notice">{error}</div>}
      {message && <div className="notice">{message}</div>}

      <section className="panel prSetCuratePanel">
        <span className="step">01</span>
        <h2>Curate PR dataset</h2>
        <p>Add a PR, edit its credited defects, or remove it from the dataset.</p>
        <form className="manualPrForm" onSubmit={addManualPr}>
          <input
            required
            placeholder="Paste a PR link or enter its number"
            value={manualPr}
            onChange={(event) => setManualPr(event.target.value)}
          />
          <button className="secondaryButton" disabled={busy === "manual"}>
            Add PR
          </button>
        </form>
      </section>

      <section className="panel resultSpreadsheetPanel">
        <PrTableControls
          search={prSearch}
          onSearchChange={(value) => {
            setPrSearch(value);
            setCurrentPage(1);
          }}
          pageSize={pageSizeInput}
          onPageSizeChange={(value) => {
            setPageSizeInput(value);
            setCurrentPage(1);
          }}
          onPageSizeBlur={() => setPageSizeInput(String(pageSize))}
          page={displayedPage}
          pageCount={pageCount}
          filteredCount={filteredPullRequests.length}
          totalCount={data.pullRequests.length}
          onPageChange={setCurrentPage}
        />
        <div className="resultTableWrap">
          <table className="resultSpreadsheet prSetTable">
            <thead>
              <tr className="prSetTitleRow">
                <th colSpan={2}>PR Set</th>
              </tr>
              <tr>
                <th>PR Info</th>
                <th>Defects</th>
              </tr>
            </thead>
            <tbody>
              {paginatedPullRequests.map((pr) => (
                <tr key={pr.id}>
                  <td className="prNameCell prSetInfoCell">
                    <div>
                      <a href={pr.url} target="_blank" rel="noreferrer">
                        #{pr.number}
                      </a>{" "}
                      <span>{pr.title}</span>
                    </div>
                    <small>
                      {pr.author} · {pr.changedFiles} files
                    </small>
                    <div className="prSetRowActions">
                      <button
                        type="button"
                        className="dangerButton"
                        disabled={busy === `delete-${pr.id}`}
                        onClick={() => void deletePullRequest(pr)}
                      >
                        Delete PR
                      </button>
                    </div>
                  </td>
                  <td className="prDefectsCell">
                    <div className="defectEditActions">
                      <button
                        type="button"
                        className="secondaryButton"
                        onClick={() =>
                          setDefectModal({ prId: pr.id, mode: "view" })
                        }
                      >
                        View
                      </button>
                      <button
                        type="button"
                        className="secondaryButton"
                        onClick={() => startEditing(pr)}
                      >
                        Edit
                      </button>
                    </div>
                    {pr.defects.length === 0 ? (
                      <span className="muted">No credited defects</span>
                    ) : (
                      <ol>
                        {pr.defects.map((defect) => (
                          <li key={defect.id}>
                            <div>
                              <span
                                className={
                                  defect.manual
                                    ? "defectSource manual"
                                    : "defectSource"
                                }
                              >
                                {defect.manual
                                  ? "Manual"
                                  : "Owner confirmed"}
                              </span>
                              <strong>{defect.body}</strong>
                            </div>
                            <small>
                              {defect.author}
                              {defect.path ? ` · ${defect.path}` : ""}
                              {defect.line ? `:${defect.line}` : ""}
                            </small>
                            {defect.originalBody !== defect.body && (
                              <details className="originalComment">
                                <summary>Original human comment</summary>
                                <p>{defect.originalBody}</p>
                              </details>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </td>
                </tr>
              ))}
              {filteredPullRequests.length === 0 && (
                <tr>
                  <td colSpan={2} className="tableEmpty">
                    {data.pullRequests.length === 0
                      ? "No PRs have been collected for this repository."
                      : `No PR number matches "${prSearch.trim()}".`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {defectModal && modalPr && (
        <div
          className="defectModalBackdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDefectModal(null);
          }}
        >
          <section
            className="defectModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="defect-modal-title"
          >
            <header>
              <div>
                <span className="eyebrow">
                  {defectModal.mode === "edit"
                    ? "Edit benchmark ground truth"
                    : "Benchmark ground truth"}
                </span>
                <h2 id="defect-modal-title">
                  PR #{modalPr.number} defects
                </h2>
                <p>{modalPr.title}</p>
              </div>
              <button
                type="button"
                className="secondaryButton"
                onClick={() => setDefectModal(null)}
              >
                Close
              </button>
            </header>

            <div className="defectModalBody">
              {modalPr.defects.length === 0 ? (
                defectModal.mode === "edit" ? (
                  <label className="modalDefectEditor">
                    <span className="defectSource manual">Manual</span>
                    <textarea
                      autoFocus
                      aria-label={`New defect for PR #${modalPr.number}`}
                      placeholder="Describe the defect that should receive benchmark credit"
                      value={drafts[`manual-defect-${modalPr.id}`] ?? ""}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [`manual-defect-${modalPr.id}`]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ) : (
                  <p className="defectModalText">No credited defects.</p>
                )
              ) : (
                modalPr.defects.map((defect, index) => (
                  <article className="modalDefectCard" key={defect.id}>
                    <div className="modalDefectHeading">
                      <strong>Defect {index + 1}</strong>
                      <span
                        className={
                          defect.manual
                            ? "defectSource manual"
                            : "defectSource"
                        }
                      >
                        {defect.manual ? "Manual" : "Owner confirmed"}
                      </span>
                    </div>
                    {defectModal.mode === "edit" ? (
                      <textarea
                        className="defectModalTextarea"
                        aria-label={`Defect ${index + 1} text for PR #${modalPr.number}`}
                        value={drafts[defect.id] ?? defect.body}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [defect.id]: event.target.value,
                          }))
                        }
                      />
                    ) : (
                      <p className="defectModalText">{defect.body}</p>
                    )}
                    <small>
                      {defect.author}
                      {defect.path ? ` · ${defect.path}` : ""}
                      {defect.line ? `:${defect.line}` : ""}
                    </small>
                    {defect.originalBody !== defect.body && (
                      <details className="originalComment modalOriginalComment">
                        <summary>Original human comment</summary>
                        <p>{defect.originalBody}</p>
                      </details>
                    )}
                  </article>
                ))
              )}
            </div>

            <footer>
              {defectModal.mode === "edit" && (
                <button
                  type="button"
                  disabled={busy === `save-${modalPr.id}`}
                  onClick={() => void saveDefects(modalPr)}
                >
                  Save
                </button>
              )}
              <button
                type="button"
                className="secondaryButton"
                onClick={() => setDefectModal(null)}
              >
                {defectModal.mode === "edit" ? "Cancel" : "Close"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
