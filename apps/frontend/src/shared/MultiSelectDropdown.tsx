import { useState, useRef, useEffect } from "react";

interface MultiSelectDropdownProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Show a search input inside the panel to filter options. Default false. */
  searchable?: boolean;
}

/**
 * Shared multi-select dropdown component used across all KPI pages.
 * Pass `searchable={true}` for the Supplier and Parent Supplier dropdowns
 * to allow the user to type and narrow down the option list.
 */
export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close panel on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Auto-focus search input when panel opens
  useEffect(() => {
    if (open && searchable && searchRef.current) {
      searchRef.current.focus();
    }
    if (!open) setQuery("");
  }, [open, searchable]);

  const toggleValue = (val: string) => {
    if (selected.includes(val)) onChange(selected.filter((v) => v !== val));
    else onChange([...selected, val]);
  };

  const displayLabel =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  const filteredOptions =
    searchable && query.trim()
      ? options.filter((opt) =>
          opt.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options;

  return (
    <div className="ms-dropdown" ref={ref}>
      <span className="ms-label">{label}</span>
      <button
        type="button"
        className="ms-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        {displayLabel} <span className="ms-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="ms-panel">
          {searchable && (
            <div className="ms-search-wrap">
              <input
                ref={searchRef}
                type="text"
                className="ms-search"
                placeholder="Search..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          {!query && (
            <label className="ms-item">
              <input
                type="checkbox"
                checked={selected.length === 0}
                onChange={() => onChange([])}
              />
              All
            </label>
          )}
          {filteredOptions.map((opt) => (
            <label key={opt} className="ms-item">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggleValue(opt)}
              />
              {opt}
            </label>
          ))}
          {filteredOptions.length === 0 && (
            <div className="ms-no-results">No results</div>
          )}
        </div>
      )}
    </div>
  );
}
