export type ParsedRepositorySource =
  | {
      provider: "github";
      key: string;
      displayName: string;
      cloneUrl: string;
      organizationUrl: null;
      projectName: null;
      repositoryName: string;
      suggestedPathFilter: string | null;
    }
  | {
      provider: "azure-devops";
      key: string;
      displayName: string;
      cloneUrl: string;
      organizationUrl: string;
      projectName: string;
      repositoryName: string;
      suggestedPathFilter: string | null;
    };

export function parseRepositorySource(input: string): ParsedRepositorySource {
  const value = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return {
      provider: "github",
      key: value,
      displayName: value,
      cloneUrl: `https://github.com/${value}.git`,
      organizationUrl: null,
      projectName: null,
      repositoryName: value.split("/")[1],
      suggestedPathFilter: null,
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Use owner/repository or an Azure DevOps repository URL containing /_git/.",
    );
  }
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const gitIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "_git",
  );
  if (gitIndex < 1 || !segments[gitIndex + 1]) {
    throw new Error("Azure DevOps URL must contain project/_git/repository.");
  }

  let organization: string;
  let projectName: string;
  if (url.hostname.toLowerCase() === "dev.azure.com") {
    if (gitIndex < 2) throw new Error("Azure DevOps URL is missing an organization.");
    organization = segments[0];
    projectName = segments[gitIndex - 1];
  } else if (url.hostname.toLowerCase().endsWith(".visualstudio.com")) {
    organization = url.hostname.split(".")[0];
    projectName = segments[gitIndex - 1];
  } else {
    throw new Error("Only GitHub and Azure DevOps repository URLs are supported.");
  }
  const repositoryName = segments[gitIndex + 1];
  const suggestedPathFilter = url.searchParams
    .get("path")
    ?.trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "") || null;
  const organizationUrl = `https://${organization}.visualstudio.com`;
  const cloneUrl = `${organizationUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repositoryName)}`;
  return {
    provider: "azure-devops",
    key: `${organization}/${projectName}/${repositoryName}`,
    displayName: `${projectName}/${repositoryName}`,
    cloneUrl,
    organizationUrl,
    projectName,
    repositoryName,
    suggestedPathFilter,
  };
}

export function parsePathFilters(value: string | null | undefined) {
  return (value ?? "")
    .split(/[,;\n]/)
    .map((item) => item.trim().replaceAll("\\", "/").replace(/^\/+/, ""))
    .filter(Boolean);
}

export function pathMatchesFilters(
  filePath: string,
  filters: string[],
): boolean {
  if (filters.length === 0) return true;
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
  return filters.some((filter) => {
    const normalizedFilter = filter.toLowerCase().replace(/\/+$/, "");
    return (
      normalized === normalizedFilter ||
      normalized.startsWith(`${normalizedFilter}/`)
    );
  });
}

export function reviewableChangedFilePaths(
  changedFiles: string[],
  creditedFindingPaths: Array<string | null | undefined>,
  filters: string[],
) {
  const normalizedChangedFiles = new Map(
    changedFiles.map((filename) => [
      filename.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase(),
      filename,
    ]),
  );
  const inFilter =
    filters.length === 0
      ? changedFiles
      : changedFiles.filter((filename) =>
          pathMatchesFilters(filename, filters),
        );
  if (filters.length > 0 && inFilter.length === 0) return [];
  const selected = new Set(inFilter);
  for (const findingPath of creditedFindingPaths) {
    if (!findingPath) continue;
    const normalized = findingPath
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .toLowerCase();
    const changedFile = normalizedChangedFiles.get(normalized);
    if (changedFile) selected.add(changedFile);
  }
  return [...selected];
}
