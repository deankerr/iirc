import { Predicate, SchemaIssue } from "effect";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** One thing wrong with a request, and where in it (API-3). */
export interface RequestIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/**
 * Says what was wrong with part of a request, in the shape `InvalidRequest` carries.
 * @param issue - What decoding found.
 * @param root - Where in the request the decoded part sits, such as `["payload"]`.
 * @returns Each issue, with a path that starts at `root`.
 */
export const issuesOf = (
  issue: SchemaIssue.Issue,
  root: readonly (string | number)[]
): readonly RequestIssue[] =>
  formatIssues(issue).issues.map(({ message, path = [] }) => ({
    message,
    path: [
      ...root,
      ...path.map((segment) => {
        // A segment is a key, or a record that holds one, and an index stays a number.
        const key = Predicate.hasProperty(segment, "key") ? segment.key : segment;

        return Predicate.isNumber(key) ? key : String(key);
      }),
    ],
  }));
