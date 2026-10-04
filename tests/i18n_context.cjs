const {createI18n}=require('../web/i18n.js');
const rows=require('../web/translations.json');
module.exports=function withI18n(context){
 const i18n=createI18n(rows);
 context.I18n=i18n;
 context.t=(id,params)=>i18n.t(id,params);
 return context;
};
