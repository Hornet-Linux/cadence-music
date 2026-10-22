/** Placeholder shapes shown while a library is loading, so pages don't jump when it arrives. */

export function SkeletonShelf({ cards = 8, label = "Loading" }: { cards?: number; label?: string }) {
  return (
    <section className="section" aria-busy="true" aria-label={label}>
      <div className="section-head">
        <div className="skeleton" style={{ width: 160, height: 22 }} />
      </div>
      <div className="shelf-row">
        {Array.from({ length: cards }, (_, i) => (
          <div className="sk-card" key={i}>
            <div className="skeleton" />
            <div className="skeleton sk-line" />
            <div className="skeleton sk-line short" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkeletonRows({ rows = 8, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="sk-rows" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton sk-row" key={i} />
      ))}
    </div>
  );
}
