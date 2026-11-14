// The Choose lists "All lists" checkbox. Pure: no host imports.
// The saved choice is the explicit list ids (POST /preview selected_list_ids), so All means every
// list Reminders has now; a list made later is not added on its own.

/** POST /preview accepts at most this many lists (preview.py selected_list_ids max_length). */
export const LIST_LIMIT = 100

/** All lists is offered for two or more lists, up to what one save accepts. */
export const offersAll = lists => lists.length > 1 && lists.length <= LIST_LIMIT

/** The All checkbox's state: true when every list is chosen, 'indeterminate' for some, false for none. */
export function allState(lists, selected) {
  const chosen = lists.filter(list => selected.has(list.id)).length
  return lists.length > 0 && chosen === lists.length ? true : chosen > 0 ? 'indeterminate' : false
}

/** Clicking All: every list when some or none are chosen, none when all are. */
export function toggleAll(lists, selected) {
  return allState(lists, selected) === true ? new Set() : new Set(lists.map(list => list.id))
}
