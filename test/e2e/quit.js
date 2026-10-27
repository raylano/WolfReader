// Closing the window must end the process (a lingering process blocks the uninstaller).
// Run: xvfb-run -a node test/e2e/quit.js  (needs test/output/picker-book.epub from page-picker.js)
const {launch,waitForBook}=require('./harness');
(async()=>{const {app,page}=await launch();
await page.evaluate(p=>window.WolfApp.openPath(p),require('path').resolve(__dirname,'../output/picker-book.epub'));
await waitForBook(page);
const proc=app.process();
const exited=new Promise(r=>proc.once('exit',r));
await page.evaluate(()=>window.close());
const res=await Promise.race([exited.then(()=>'exited'),new Promise(r=>setTimeout(()=>r('STILL RUNNING'),8000))]);
console.log(res);process.exit(res==='exited'?0:1)})();
