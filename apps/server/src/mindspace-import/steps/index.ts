import type { ImportStep } from '../runner';
import { docsStep } from './docs.step';
import { peopleStep } from './people.step';
import { projectsStep } from './projects.step';
import { sharesStep } from './shares.step';

/** Every step, in the fixed order people, projects, docs, shares. */
export const ALL_STEPS: ImportStep[] = [
  peopleStep,
  projectsStep,
  docsStep,
  sharesStep,
];
