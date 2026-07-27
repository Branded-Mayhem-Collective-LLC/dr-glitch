import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import ProcessLoader from "./ProcessLoader";

type SharedProps = {
  children: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
};

type LinkProps = SharedProps & {
  to: string;
  type?: never;
  disabled?: never;
};

type ButtonProps = SharedProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> & {
    to?: never;
  };

type Props = LinkProps | ButtonProps;

function ActionContent({
  children,
  busy,
  busyLabel,
}: Pick<SharedProps, "children" | "busy" | "busyLabel">) {
  return (
    <>
      <span className="process-action-plates" aria-hidden="true">
        <span className="process-action-plate is-cyan" />
        <span className="process-action-plate is-magenta" />
        <span className="process-action-plate is-yellow" />
        <span className="process-action-plate is-black" />
      </span>
      <span className="process-action-label">
        {busy ? <ProcessLoader compact decorative /> : null}
        <span>{busy ? busyLabel ?? children : children}</span>
      </span>
    </>
  );
}

/**
 * A universal primary action derived from Elise's "CMYK Hover Effect."
 * Process plates separate on hover/focus and snap back into registration.
 * Use only where all four channels are semantically involved.
 */
export default function ProcessAction(props: Props) {
  const className = ["process-action", props.className].filter(Boolean).join(" ");
  const content = (
    <ActionContent
      busy={props.busy}
      busyLabel={props.busyLabel}
    >
      {props.children}
    </ActionContent>
  );

  if ("to" in props && props.to) {
    return (
      <Link className={className} to={props.to}>
        {content}
      </Link>
    );
  }

  const {
    busy: _busy,
    busyLabel: _busyLabel,
    children: _children,
    className: _className,
    ...buttonProps
  } = props as ButtonProps;

  return (
    <button
      {...buttonProps}
      className={className}
      aria-busy={props.busy || undefined}
      disabled={buttonProps.disabled || props.busy}
    >
      {content}
    </button>
  );
}
