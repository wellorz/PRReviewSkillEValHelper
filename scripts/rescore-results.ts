import { rescoreCompletedResults } from "../src/lib/workflow";

async function main() {
  const repositoryId = process.argv[2] ? Number(process.argv[2]) : undefined;
  if (repositoryId !== undefined && !Number.isInteger(repositoryId)) {
    throw new Error("Repository ID must be an integer");
  }

  const result = await rescoreCompletedResults(repositoryId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
