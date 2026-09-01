import { Icon } from "../icons";

export const TASK_CATEGORIES = [
  { id: "class", label: "Class", icon: "calendar" },
  { id: "assignment", label: "Assignment", icon: "document" },
  { id: "quiz", label: "Quiz", icon: "target" },
  { id: "exam", label: "Exam", icon: "warning" },
  { id: "lab", label: "Lab", icon: "lab" },
  { id: "paper", label: "Paper", icon: "document" },
  { id: "project", label: "Project", icon: "flag" },
];

export const TASK_CATEGORY_META = Object.fromEntries(
  TASK_CATEGORIES.map((category) => [category.id, category]),
);

export default function TaskLegend() {
  return (
    <aside className="task-legend" aria-labelledby="timeline-key-title">
      <span className="task-legend-title" id="timeline-key-title">Timeline key</span>
      <ul className="task-legend-items">
        {TASK_CATEGORIES.map((category) => (
          <li className={`task-legend-item task-${category.id}`} key={category.id}>
            <span className="task-legend-swatch" aria-hidden="true" />
            <Icon name={category.icon} size={13} strokeWidth={1.9} />
            <span>{category.label}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
