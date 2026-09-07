import Link from "next/link";

export function PageNavigation({
  previous,
  next,
}: {
  previous: { href: string; label: string };
  next: { href: string; label: string };
}) {
  return (
    <nav className="pageNavigation" aria-label="Page navigation">
      <Link href={previous.href} className="backLink">
        ← {previous.label}
      </Link>
      <Link href={next.href} className="backLink">
        {next.label} →
      </Link>
    </nav>
  );
}
