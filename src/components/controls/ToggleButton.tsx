interface ToggleButtonProps {
  label: string;
  active: boolean;
  className?: string;
  onToggle: (active: boolean) => void;
}

export function ToggleButton({ label, active, className = '', onToggle }: ToggleButtonProps) {
  return (
    <button
      className={`btn ${className} ${active ? 'active' : ''}`}
      onClick={() => onToggle(!active)}
    >
      {label}
    </button>
  );
}
