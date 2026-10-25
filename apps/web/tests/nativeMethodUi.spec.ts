import {test,expect} from "@playwright/test";
import {headers,head} from "./fileFixtures";
import {revealPanel} from "./flowAssertions";
import {writeFileSync} from "node:fs";

// Overloads deliberately share one source line. Exact selected signature must disambiguate.
const source="public class TargetUI {\n public static int choose(int value){return value+1;} public static long choose(long value){return value+2;}\n}\n";
test("real method UI selects the exact same-line long overload and verifies its supplied oracle without main",async({page},info)=>{
 test.setTimeout(300000);
 const request=page.request;
 const made=await request.post("/api/v1/projects",{headers:await headers(request),data:{name:"Native method UI "+crypto.randomUUID()}});expect(made.status()).toBe(201);const id=(await made.json()).data.id,base="/api/v1/projects/"+id;
 const saved=await request.post(base+"/revisions",{headers:await headers(request,"empty"),data:{files:[{path:"TargetUI.java",content:source}],intent:"semantic_edit"}});expect(saved.status()).toBe(201);const original=(await saved.json()).data;
 const analyzing=await request.post(base+"/revisions/"+original.id+"/analysis",{headers:await headers(request),data:{}});expect(analyzing.status()).toBe(202);const job=(await analyzing.json()).data;
 await expect.poll(async()=>(await(await request.get(base+"/jobs/"+job.id)).json()).data.status,{timeout:120000}).toBe("succeeded");
 await page.goto("/projects/"+id);
 await revealPanel(page,"project","Проект");
 await page.locator(".method-item").filter({hasText:/^choose\(long\)$/}).click();
 await revealPanel(page,"tests","Тесты");
 await page.getByRole("button",{name:"Тестировать метод",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Тесты отдельного метода"});await expect(dialog).toBeVisible();
 const select=dialog.getByRole("combobox",{name:"Метод",exact:true});await expect(select).toHaveAttribute("data-value",JSON.stringify(["TargetUI","choose",["long"]]));
 await dialog.getByLabel("Тесты метода JSON").fill(JSON.stringify([{id:"ui-long",arguments:["9007199254740993"],expectedReturn:"9007199254740995",expectedArgumentsAfter:["9007199254740993"]}],null,2));
 const submitted=page.waitForResponse(response=>response.url().endsWith("/comparisons")&&response.request().method()==="POST");
 await dialog.getByRole("button",{name:"Запустить тесты метода",exact:true}).click();const response=await submitted;expect(response.status()).toBe(202);const pending=(await response.json()).data;
 await expect(dialog.getByLabel("Результат тестов метода")).toContainText("Совпало на 1 входах, 3 повтора на версию",{timeout:180000});
 await expect(dialog.getByLabel("Результат тестов метода")).toContainText("Результат: 9007199254740995");
 const completed=(await(await request.get(base+"/jobs/"+pending.id)).json()).data;
 const report=completed.result.report;expect(report).toMatchObject({mode:"method",comparisonPolicyId:"method-v1",outcome:"matched_on_tests",baseRevisionId:original.id,candidateRevisionId:original.id,methodTarget:{ownerType:"TargetUI",methodName:"choose",parameterTypes:["long"]},observedRepeatCounts:{base:3,candidate:3}});
 writeFileSync(info.outputPath("actual-ui-native-method-report.json"),JSON.stringify({source,original,report},null,2));
 expect((await head(request,base)).id).toBe(original.id);
 await page.screenshot({path:info.outputPath("native-method-success.png"),animations:"disabled"});
 await info.attach("actual-ui-native-method-report",{body:JSON.stringify({source,original,report}),contentType:"application/json"});
});
