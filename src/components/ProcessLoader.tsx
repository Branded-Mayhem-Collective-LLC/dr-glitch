type Props = {
  label?: string;
  compact?: boolean;
  decorative?: boolean;
};

/**
 * Four process plates moving in and out of register.
 *
 * Adapted from Black from 80's "Loading CMYK" CodePen. The original circular
 * spinner used screen-primary colors; this version obeys the product's exact
 * process inks, square geometry, and reduced-motion contract.
 */
export default function ProcessLoader({
  label = "Working",
  compact = false,
  decorative = false,
}: Props) {
  return (
    <span
      className={`process-loader ${compact ? "is-compact" : ""}`}
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? "true" : undefined}
      data-testid="process-loader"
    >
      <span className="process-loader-plate is-cyan" />
      <span className="process-loader-plate is-magenta" />
      <span className="process-loader-plate is-yellow" />
      <span className="process-loader-plate is-black" />
    </span>
  );
}
