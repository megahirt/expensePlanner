import type { Category } from '@/types/models';

interface Props {
  categories: readonly Category[];
  value: string | null;
  placeholder?: string;
  onChange: (categoryId: string | null) => void;
}

export function CategoryPicker({ categories, value, placeholder, onChange }: Props) {
  return (
    <select
      className="category-picker"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{placeholder ?? 'Uncategorized'}</option>
      {categories
        .filter((c) => !c.archived)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}
