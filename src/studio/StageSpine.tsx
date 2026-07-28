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

/** Persistent, directly selectable stages for the inspector tab panels. */
export default function StageSpine({ stages, active, onJump }: Props) {
  return (
    <nav className="stage-spine" aria-label="Studio stages" role="tablist">
      {stages.map((stage) => (
        <button
          key={stage.id}
          id={`stage-tab-${stage.id}`}
          type="button"
          role="tab"
          data-testid={`stage-${stage.id}`}
          data-complete={stage.complete ? "true" : "false"}
          aria-controls={stage.id}
          aria-selected={stage.id === active}
          className={[
            "stage-step",
            stage.complete ? "is-complete" : "",
            stage.id === active ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-current={stage.id === active ? "step" : undefined}
          title={`Open ${stage.label} controls`}
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
