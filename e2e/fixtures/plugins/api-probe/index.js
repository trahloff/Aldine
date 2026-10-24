/**
 * Test fixture for tests/06-plugins.spec.ts: a plugin that reads the plugin
 * API's identity members while it activates, registers a panel showing them,
 * and leaves the `aldine` object on window so the test can call the rest.
 */
export default {
  activate(aldine) {
    window.__aldineProbe = aldine;
    const seen = `version ${aldine.version}, project ${aldine.project.id}, branch ${aldine.project.branch}`;
    aldine.ui.registerSidebarPanel({
      id: 'api-probe',
      title: 'API probe',
      render(el) {
        const p = document.createElement('p');
        p.dataset.testid = 'api-probe-panel';
        p.textContent = seen;
        el.append(p);
      },
    });
  },
};
