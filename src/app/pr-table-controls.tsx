"use client";

type PrTableControlsProps = {
  search: string;
  onSearchChange: (value: string) => void;
  pathFilter?: string;
  onPathFilterChange?: (value: string) => void;
  pathFilterEnabled?: boolean;
  onPathFilterEnabledChange?: (value: boolean) => void;
  showSelectedOnly?: boolean;
  onShowSelectedOnlyChange?: (value: boolean) => void;
  showReviewedOnly?: boolean;
  onShowReviewedOnlyChange?: (value: boolean) => void;
  refreshingScore?: boolean;
  onRefreshScore?: () => void;
  pageSize: string;
  onPageSizeChange: (value: string) => void;
  onPageSizeBlur: () => void;
  page: number;
  pageCount: number;
  filteredCount: number;
  totalCount: number;
  onPageChange: (page: number) => void;
};

export function PrTableControls({
  search,
  onSearchChange,
  pathFilter,
  onPathFilterChange,
  pathFilterEnabled,
  onPathFilterEnabledChange,
  showSelectedOnly,
  onShowSelectedOnlyChange,
  showReviewedOnly,
  onShowReviewedOnlyChange,
  refreshingScore,
  onRefreshScore,
  pageSize,
  onPageSizeChange,
  onPageSizeBlur,
  page,
  pageCount,
  filteredCount,
  totalCount,
  onPageChange,
}: PrTableControlsProps) {
  return (
    <div className="prTableControls">
      <div className="prTableFilters">
        <label>
          <span>Search PR number</span>
          <input
            type="search"
            inputMode="numeric"
            placeholder="e.g. 5251817"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        {pathFilter !== undefined && onPathFilterChange && (
          <label className="prPathFilterField">
            <span>Changed file path</span>
            <input
              type="text"
              placeholder="e.g. sources/dev/Store"
              value={pathFilter}
              onChange={(event) => onPathFilterChange(event.target.value)}
            />
          </label>
        )}
        {pathFilterEnabled !== undefined &&
          onPathFilterEnabledChange && (
            <label className="prTableToggle">
              <input
                type="checkbox"
                checked={pathFilterEnabled}
                onChange={(event) =>
                  onPathFilterEnabledChange(event.target.checked)
                }
              />
              <span>Apply path filter</span>
            </label>
          )}
        {showSelectedOnly !== undefined && onShowSelectedOnlyChange && (
          <label className="prTableToggle">
            <input
              type="checkbox"
              checked={showSelectedOnly}
              onChange={(event) =>
                onShowSelectedOnlyChange(event.target.checked)
              }
            />
            <span>Show selected</span>
          </label>
        )}
        {showReviewedOnly !== undefined && onShowReviewedOnlyChange && (
          <label className="prTableToggle">
            <input
              type="checkbox"
              checked={showReviewedOnly}
              onChange={(event) =>
                onShowReviewedOnlyChange(event.target.checked)
              }
            />
            <span>Show reviewed</span>
          </label>
        )}
        {onRefreshScore && (
          <button
            type="button"
            className="secondaryButton compact"
            disabled={refreshingScore}
            onClick={onRefreshScore}
          >
            {refreshingScore ? "Refreshing…" : "Refresh Score"}
          </button>
        )}
      </div>
      <div className="prTablePagination">
        <label className="prPageSize">
          <span>PRs per page</span>
          <input
            type="number"
            min={1}
            max={500}
            value={pageSize}
            onChange={(event) => onPageSizeChange(event.target.value)}
            onBlur={onPageSizeBlur}
          />
        </label>
        <span className="prTableResultCount">
          {filteredCount === totalCount
            ? `${totalCount} PRs`
            : `${filteredCount} of ${totalCount} PRs`}
        </span>
        <button
          type="button"
          className="secondaryButton"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="secondaryButton"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
