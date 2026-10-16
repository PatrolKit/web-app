import type { ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/pro-duotone-svg-icons';

/** A link that opens in a new tab, and says so with the "open in new tab" icon, e.g. "View in Square". */
export default function NewTabLink({ href, className = '', children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`whitespace-nowrap text-brand-500 hover:underline ${className}`}>
      {children}
      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="ml-1 h-2.5 w-2.5" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
