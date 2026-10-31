import { fromObservable, observable, type Source, type Subscribable } from "justdom-signal";
import { stylesheet, className, CLASS_NAME } from "justdom";

/**
 * Whatever the machine already has. The panels used to be set in Zen Dots,
 * mounted as a `@font-face`. They no longer are: a web font is
 * one more thing the measuring has to wait for before a panel can be built,
 * and nothing here asks for anything a system sans does not do.
 */
export const fontFamily = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * Class names are observables (they register their stylesheet on first
 * subscription), so putting several on one element means combining them —
 * interpolating them into a plain template string would stringify the
 * observable, not the name.
 */
export function classes(...names: Subscribable<string>[]): Source<string> {
  const nodes = names.map((name) => fromObservable(name));
  return observable(() => nodes.map((node) => node.get()).join(" "));
}

/**
 * The shared look of every panel. Rounded corners and a real border, so each
 * card is itself a demonstration of the SDF box path.
 */
export const cardStyle = stylesheet`
  .${CLASS_NAME} {
    box-sizing: border-box;
    font-family: ${fontFamily};
    width: 22rem;
    padding: 1.25rem 1.5rem 1.5rem;
    background-color: rgb(250, 250, 253);
    border: 2px solid rgb(214, 218, 230);
    border-radius: 18px;
    color: rgb(40, 44, 58);
  }

  .${CLASS_NAME} * {
    box-sizing: border-box;
  }
`;

export const headingStyle = className`
  margin: 0 0 1rem;
  font-size: 1.4rem;
`;

export const captionStyle = className`
  margin: 0.9rem 0 0.35rem;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(122, 128, 148);
`;

export const rowStyle = className`
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;
