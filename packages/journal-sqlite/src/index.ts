/**
 * The production adapter of the Journal port, on SQLite. See the README for the file
 * layout, the settings, and what "durable" means here.
 *
 * @packageDocumentation
 */
export { layerSqliteJournal, makeSqliteJournal } from "./sqlite-journal.ts";
