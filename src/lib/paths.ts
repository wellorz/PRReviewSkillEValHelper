import path from "node:path";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DATASETS_DIR = path.join(DATA_DIR, "datasets");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const QUICK_REVIEWS_DIR = path.join(DATA_DIR, "quick-reviews");
export const RUNTIME_DIR = path.join(ROOT_DIR, "runtime");
export const DATABASE_PATH = path.join(DATA_DIR, "benchmark.sqlite");

export function repositoryDatasetDir(slug: string) {
  return path.join(DATASETS_DIR, slug.replace("/", "__"));
}

export function prDatasetDir(slug: string, number: number) {
  return path.join(repositoryDatasetDir(slug), `pr-${number}`);
}

export function runDir(runId: number) {
  return path.join(RUNS_DIR, `run-${runId}`);
}

export function quickReviewDir(reviewId: number) {
  return path.join(QUICK_REVIEWS_DIR, `review-${reviewId}`);
}
