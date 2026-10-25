import { CircleHelp } from "lucide-react";

export default function TourButton({
  label = "Обучение",
  mode = "full",
}: {
  label?: string;
  mode?: "full" | "context";
}) {
  return (
    <button
      type="button"
      className="tour-launcher"
      data-tour="help"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("java-blueprints:tour", { detail: { mode } }),
        )
      }
    >
      <CircleHelp size={17} aria-hidden="true" />
      {label}
    </button>
  );
}
