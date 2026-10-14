/** Shared suggestion contract; providers own storage and lookup policy. */
export interface Suggestion {
  id: string;
  label: string;
  type?: string;
  [key: string]: unknown;
}
export interface IAutocompleteSource { getSuggestions(query: string): Promise<Suggestion[]> }
