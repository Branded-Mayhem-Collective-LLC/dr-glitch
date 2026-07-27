export type Stage = {
  id: string;
  number: string;
  label: string;
  complete: boolean;
};

type Props = {
  stages: Stage[];
  active: string;
  onJump: (id: string) => void;
};

/** §7: the four stages stay visible with completion state and jump-to. */
export default function StageSpine({ stages, active, onJump }: Props) {
  return (
    <nav className="stage-spine" aria-label="Stages">
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          data-testid={`stage-${stage.id}`}
          data-complete={stage.complete ? "true" : "false"}
          className={[
            "stage-step",
            stage.complete ? "is-complete" : "",
            stage.id === active ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-current={stage.id === active ? "step" : undefined}
          onClick={() => onJump(stage.id)}
        >
          <span className="stage-number">{stage.number}</span>
          <span className="stage-label">{stage.label}</span>
          {stage.complete ? (
            <span className="stage-mark" aria-label="complete">
              ■
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
