import type {ReactNode} from 'react';
import {navigate} from 'wouter/use-browser-location';

export type Props<S> = {
  children: ReactNode;
  href: string;
  className?: string | undefined;
  title?: string | undefined;
  state?: S | undefined;
};
/**
 * The Link from wouter uses onClick and there's no way to change it.
 * We like mousedown here at Rocicorp.
 */
export function Link<S>({children, href, className, title, state}: Props<S>) {
  const isPrimary = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.button !== 0) {
      return false;
    }
    return true;
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (isPrimary(e)) {
      navigate(href, {state});
    }
  };
  const onClick = (e: React.MouseEvent) => {
    if (isPrimary(e) && !e.defaultPrevented) {
      e.preventDefault();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // In html links are not activated by space key, but we want to it to be
    // more consistent with buttons, especially since it is hard to determine
    // what is a link vs a button in our UI.
    if (e.key === 'Enter' || e.key === ' ') {
      navigate(href, {state});
      e.preventDefault();
    }
  };

  return (
    <a
      href={href}
      title={title}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={className}
    >
      {children}
    </a>
  );
}
