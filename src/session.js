// In-memory only for active operations - cleaned immediately after use
const activeOperations = new Map();
const userFlowState = new Map();

function getUserFlow(userId) {
  return userFlowState.get(userId);
}

function setUserFlow(userId, flow) {
  userFlowState.set(userId, flow);
}

function clearUserFlow(userId) {
  userFlowState.delete(userId);
}

function setActiveOperation(userId, operation) {
  activeOperations.set(userId, { operation, startedAt: Date.now() });
}

function getActiveOperation(userId) {
  return activeOperations.get(userId);
}

function clearActiveOperation(userId) {
  activeOperations.delete(userId);
}

// Clean stale operations (older than 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, op] of activeOperations) {
    if (now - op.startedAt > 30 * 60 * 1000) {
      activeOperations.delete(userId);
      userFlowState.delete(userId);
    }
  }
}, 5 * 60 * 1000);

function defaultGroupFlow() {
  return {
    step: "name",
    name: "", count: 1, numbering: true, description: "",
    photo: null, disappearing: 0, members: [], makeAdmin: false,
    permissions: { sendMessages: true, editInfo: true, addMembers: true, approveMembers: false },
  };
}

function defaultFeatureFlow(feature) {
  return {
    feature,
    step: "group_type",
    allGroups: [],
    selectedIds: [],
    page: 0,
    keyword: "",
    adminNumbers: [],
  };
}

module.exports = { 
  getUserFlow, setUserFlow, clearUserFlow,
  setActiveOperation, getActiveOperation, clearActiveOperation,
  defaultGroupFlow, defaultFeatureFlow 
};
