// Category filter chips + the deterministic category→color palette, shared by
// the options Clips page. Lives outside the page module on purpose:
// lazy-loaded pages importing it from the clips module pulled other page
// component trees (AlertDialog, DropdownMenu…) into the first chunk that loaded.
import { useI18n } from '@/lib/i18n';

// category color palette — deterministic by category name; deliberately NOT theme
// tokens: these are data-viz hues that must stay distinguishable in both themes
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'];
const colorFor = (cat: string, cats: string[]) => COLORS[cats.indexOf(cat) % COLORS.length];

/** "All" + category filter chips, used by the options Clips page. */
export function CategoryChips({ cats, selected, onToggle }: {
  cats: string[];
  selected: string | null;
  onToggle: (cat: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1">
      <button
        type="button"
        className={`rounded px-2 py-0.5 text-xs ${!selected ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
        onClick={() => onToggle(null)}
      >
        {t('clips.all')}
      </button>
      {cats.map((c) => (
        <button
          key={c}
          type="button"
          className={`rounded px-2 py-0.5 text-xs ${selected === c ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
          style={selected === c ? {} : { borderLeft: `3px solid ${colorFor(c, cats)}` }}
          onClick={() => onToggle(selected === c ? null : c)}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
