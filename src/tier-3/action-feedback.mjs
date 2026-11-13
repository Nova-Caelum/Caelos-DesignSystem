// The host owns the operation, edit events, eligibility and accessible status output.
// Request identity prevents late results from confirming a newer action or revision.
export function createActionFeedback({onChange = () => {}, showSuccess = true} = {}) {
  let revision = {}, active, state = 'default';
  const publish = next => { state = next; onChange(next); };
  const edited = () => {
    revision = {};
    // Keep an in-flight operation visibly pending until it actually settles.
    if (!active) publish('default');
  };
  return {
    get state() { return state; },
    begin() {
      if (active || state === 'success') return undefined;
      const request = Object.freeze({revision});
      active = request;
      publish('pending');
      return request;
    },
    edited,
    eligible: edited,
    complete(request) {
      if (!request || request !== active) return false;
      active = undefined;
      publish(showSuccess && request.revision === revision ? 'success' : 'default');
      return true;
    },
    fail(request) {
      if (!request || request !== active) return false;
      active = undefined;
      publish('error');
      return true;
    },
  };
}
