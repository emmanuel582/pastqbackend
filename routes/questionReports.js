import { Router } from 'express';
import { requireAuthenticatedUser, requireAdmin, ownsSession } from '../services/auth/middleware.js';
import { rateLimit } from '../services/http/security.js';
import { getBundle, saveBundle } from '../services/library/store.js';
import { getSession } from '../services/vision/store.js';
import { reviewQuestions } from '../services/vision/reviewedMaterials.js';
import { reviewedMaterial } from '../services/vision/reviewedMaterials.js';
import { saveReviewedMaterial } from '../services/vision/reviewedMaterialStore.js';
import { withSessionLock } from '../services/vision/processor.js';
import { saveReport,listReports,resolveReport } from '../services/library/questionReports.js';
const router=Router();
router.use(requireAuthenticatedUser,rateLimit({limit:60,keyPrefix:'question-reports'}));
router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.get('/',(req,res)=>res.json({items:listReports(req.auth.ownerKey)}));
router.get('/admin',requireAdmin,(req,res)=>res.json({items:listReports(null,true)}));
function reportSource(report) {
  const bundle=/^[A-Za-z0-9_-]{1,128}$/.test(report.bundleId)?getBundle(report.bundleId):null;
  return bundle || getSession(report.bundleId.replace(/^vision:/,''));
}
router.get('/admin/:id/source',requireAdmin,(req,res)=>{
  try {
    const report=listReports(String(req.query.owner||'')).find(row=>row.id===req.params.id);
    if(!report)return res.status(404).json({error:'Report not found'});
    const material=reportSource(report),question=material?.questions?.find(q=>String(q.id)===report.questionId);
    if(!question)return res.status(404).json({error:'Source question not found'});
    const html=[question.questionHtml,...(question.optionsHtml||[]),question.answerHtml,question.explanationHtml,question.passage].join(' '),assets={};
    for(const match of html.matchAll(/pastq-asset:([a-f0-9]{64})/g))if(material.assets?.[match[1]])assets[match[1]]=material.assets[match[1]];
    res.json({question,assets,version:material.updated_at||material.updatedAt,title:material.title||material.name});
  }catch{res.status(400).json({error:'Source question could not load'});}
});
router.post('/',(req,res)=>{
  try {
    const input=req.body;
    if (!/^[a-f0-9-]{36}$/i.test(input?.id||'') || typeof input.bundleId!=='string' || input.bundleId.length>128 || typeof input.questionId!=='string' || input.questionId.length>300 || !['answer','diagram','wording','solution','topic'].includes(input.category) || typeof input.note!=='string' || input.note.length>2000 || input.version!=null&&typeof input.version!=='string') return res.status(400).json({error:'Check the report details.'});
    let material=/^[A-Za-z0-9_-]{1,128}$/.test(input.bundleId)?getBundle(input.bundleId):null;
    if (!material) {const session=getSession(input.bundleId.replace(/^vision:/,''));if (session&&ownsSession(req,session)) material=session;}
    const question=material?.questions?.find(q=>String(q.id)===input.questionId);
    if (!question) return res.status(404).json({error:'Question not found. Refresh this material before reporting it.'});
    res.json(saveReport(req.auth.ownerKey,input,question));
  } catch { res.status(400).json({error:'Could not save this report.'}); }
});
router.patch('/admin/:id',requireAdmin,async(req,res)=>{
  try {
    const {owner,status,resolution,edit,expectedVersion}=req.body||{};
    if (typeof owner!=='string'||!['reviewing','corrected','no_change'].includes(status)||typeof resolution!=='string'||resolution.length>2000||(status!=='reviewing'&&!resolution.trim())) return res.status(400).json({error:'Enter a review status and resolution.'});
    const report=listReports(owner).find(row=>row.id===req.params.id);if(!report)return res.status(404).json({error:'Report not found'});
    let correctedVersion=null;
    if(status==='corrected') {
      const bundle=reportSource(report), question=bundle?.questions.find(q=>String(q.id)===report.questionId);
      if(!question||!edit)return res.status(400).json({error:'An approved question edit is required.'});
      const assertVersion=material=>{if(typeof expectedVersion!=='string'||expectedVersion!==String(material.updated_at||material.updatedAt))throw Object.assign(new Error('This source changed during your review. Reopen it before publishing.'),{status:409});};
      assertVersion(bundle);
      const [fixed]=reviewQuestions({status:'completed',questions:[question]},[{...question,...edit,id:question.id}]);
      if(fixed.needsReview)return res.status(400).json({error:'Confirm the answer key before resolving a correction.'});
      const patch={...fixed,answerSource:'admin_review',reviewedAt:new Date().toISOString()};
      if(bundle.ownerKey){
        await withSessionLock(bundle.id,session=>{assertVersion(session);const original=session.questions.find(q=>String(q.id)===report.questionId);Object.assign(original,patch);session.updatedAt=Date.now();if(session.approvedAt)saveReviewedMaterial(session.ownerKey,reviewedMaterial(session));});
        correctedVersion=new Date(getSession(bundle.id).updatedAt).toISOString();
      }else{Object.assign(question,patch);saveBundle(bundle);correctedVersion=bundle.updated_at;}
    }
    res.json(resolveReport(owner,report.id,{status,resolution:resolution.trim(),correctedVersion}));
  } catch(error) {res.status(error.status||400).json({error:error.message||'Could not resolve report.'});}
});
export default router;
