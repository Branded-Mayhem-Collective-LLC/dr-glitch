/** Public surface of the Help subsystem. */

export {
  getHelpTopic,
  HELP_CATEGORY_LABELS,
  HELP_TOPICS,
  type HelpCategory,
  type HelpTopic,
} from "./content";
export { searchHelp, type HelpSearchResult } from "./search";
export { HelpPanel, type HelpPanelProps } from "./HelpPanel";
