const ChartMutations = require('../web/mutations.js');
// Exercise the real journal even when a focused UI test extracts app functions.
module.exports = function mutationContext(context, send) {
  context.ChartEditing = require('../web/editing.js');
  context.chartMutations = {resolveId:id=>journal ? journal.resolveId(id) : id};
  context.document ||= {};
  let journal;
  const ensure = () => journal ||= ChartMutations.create({
    initial:{templates:[],...context.state.data},
    send:(...args)=>send(...args),
    publish(data) {
      context.state.data=data;
      context.renderSidebar?.();context.renderTimeline?.({preserveInspector:true});
    },
  });
  context.api=(path,options={})=>path==='/api/state'?ensure().refresh():ensure().mutate(path,options);
  return {get journal(){return ensure();}};
};
