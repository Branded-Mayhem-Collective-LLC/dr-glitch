import { ArrowRight, Crosshair, LockKeyhole, Monitor } from "lucide-react";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../brand";
import ProcessAction from "../components/ProcessAction";
import ProcessLoader from "../components/ProcessLoader";

const proofFacts = [
  { icon: Crosshair, value: "4", label: "live process plates" },
  { icon: LockKeyhole, value: "0", label: "uploads to a server" },
  { icon: Monitor, value: "1", label: "browser-native proof" },
] as const;

const screenDots = Array.from({ length: 256 }, (_, index) => {
  const column = index % 16;
  const row = Math.floor(index / 16);
  const size = 2 + ((column + row) % 4);
  return { x: column * 15 + 5, y: row * 15 + 5, size };
});

export default function Landing() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Product">
        <a
          className="landing-wordmark glitch"
          data-text={PRODUCT_NAME}
          href="#top"
        >
          {PRODUCT_NAME}
        </a>
        <span>{PRODUCT_TAGLINE}</span>
        <a className="landing-nav-link" href="#proof">
          The proof
        </a>
      </nav>

      <section className="blitz-hero" id="top" aria-labelledby="landing-title">
        <div className="blitz-field" aria-hidden="true">
          <span className="blitz-plate is-cyan" />
          <span className="blitz-plate is-magenta" />
          <span className="blitz-plate is-yellow" />
          <span className="blitz-plate is-black" />
          <svg
            className="blitz-screen"
            viewBox="0 0 240 240"
            fill="#101010"
            role="presentation"
          >
            {screenDots.map(({ x, y, size }, index) => (
              <rect
                key={index}
                x={x}
                y={y}
                width={size}
                height={size}
                fill="#101010"
              />
            ))}
          </svg>
        </div>

        <div className="landing-hero-copy">
          <p className="landing-kicker">Four plates. One proof.</p>
          <h1 id="landing-title">
            <span>Separate</span>
            <span>what the screen</span>
            <span>cannot see.</span>
          </h1>
          <p className="landing-deck">
            A browser-native CMYK separation studio for people who think in
            ink, angles, registration, and paper—not presets.
          </p>
          <div className="landing-actions">
            <ProcessAction to="/">Open the studio</ProcessAction>
            <span className="landing-local-note">
              <ProcessLoader compact label="Browser processing active" />
              Your artwork stays on this device.
            </span>
          </div>
        </div>

        <p className="blitz-caption">
          Inspired by Arley McBlain&apos;s CMYK Blitz. Rebuilt as four
          production plates.
        </p>
      </section>

      <section className="landing-proof" id="proof" aria-labelledby="proof-title">
        <div className="landing-proof-heading">
          <p className="landing-kicker">The proof, before the promise</p>
          <h2 id="proof-title">Built around the press decision.</h2>
        </div>
        <div className="landing-fact-grid">
          {proofFacts.map(({ icon: Icon, value, label }) => (
            <article className="landing-fact" key={label}>
              <Icon size={20} aria-hidden="true" />
              <strong>{value}</strong>
              <span>{label}</span>
            </article>
          ))}
        </div>
        <ProcessAction to="/">
          Build a separation <ArrowRight size={16} aria-hidden="true" />
        </ProcessAction>
      </section>
    </main>
  );
}
