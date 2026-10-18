interface Props {
  seed: string;
  label?: string;
  showInitial?: boolean;
}

// Deterministic gradient placeholder so the UI looks populated without needing
// network artwork. Real artwork (when a plugin provides it) replaces this.
const palettes = [
  ["#7c5cff", "#4ad7d4"],
  ["#ff6b9d", "#ffc371"],
  ["#36d1dc", "#5b86e5"],
  ["#f093fb", "#f5576c"],
  ["#43e97b", "#38f9d7"],
  ["#fa709a", "#fee140"],
  ["#30cfd0", "#330867"],
  ["#a18cd1", "#fbc2eb"],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function CoverArt({ seed, label, showInitial = true }: Props) {
  const h = hash(seed);
  const [a, b] = palettes[h % palettes.length];
  const angle = (h % 8) * 45;
  return (
    <div
      className="cover"
      style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }}
      aria-label={label}
    >
      {showInitial && (label?.[0]?.toUpperCase() ?? "")}
    </div>
  );
}
