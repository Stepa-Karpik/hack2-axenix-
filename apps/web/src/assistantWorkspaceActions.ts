import type { WorkspaceController } from "./Workspace";
import type { AssistantResult } from "./assistantBridge";
import {
  activePanels, groups, movePanel, panelIds, panelLabels, revealPanel, resizeSplit,
  visiblePanels, visibleRoot,
} from "./workspaceLayout.ts";
import type { LayoutNode, PanelId, WorkspaceLayout } from "./workspaceLayout.ts";

const failure = (message: string): AssistantResult => ({ ok: false, message });
function panel(value: unknown): PanelId | null {
  return typeof value === "string" && panelIds.includes(value as PanelId) ? value as PanelId : null;
}
type LayoutResult = { layout: WorkspaceLayout; result: AssistantResult };

export function swapWorkspacePanels(layout: WorkspaceLayout, first: PanelId, second: PanelId): LayoutResult {
  const fail=(message:string):LayoutResult=>({layout,result:failure(message)});
  if(first===second) return fail("Выберите две разные панели.");
  if(first==="graph" || second==="graph") return fail("Схема — постоянный холст. Менять её местами с панелями нельзя.");
  if(!visiblePanels(layout).includes(first)||!visiblePanels(layout).includes(second)) return fail("Для обмена местами сначала откройте обе панели.");
  const source=groups(visibleRoot(layout)).find(g=>g.tabs.includes(first));
  const target=groups(visibleRoot(layout)).find(g=>g.tabs.includes(second));
  if(!source||!target||source.id===target.id) return fail("Панели находятся в одной группе вкладок. Сначала разместите их отдельно.");
  const revealed=revealPanel(revealPanel(layout,first),second);
  return {layout:movePanel(revealed,first,target.id,"center"),result:{ok:true,message:`Панели «${panelLabels[first]}» и «${panelLabels[second]}» поменялись местами.`}};
}

export function resizeWorkspacePanel(layout: WorkspaceLayout, target: PanelId, axis: "width"|"height", percent: number): LayoutResult {
  const fail=(message:string):LayoutResult=>({layout,result:failure(message)});
  if(target==="graph") return fail("Схема — постоянный холст; измените размер соседней панели.");
  if(!Number.isInteger(percent)||percent<15||percent>85) return fail("Размер должен быть целым числом от 15 до 85%.");
  if(!visiblePanels(layout).includes(target)) return fail("Сначала откройте панель, размер которой нужно изменить.");
  const contains=(node:LayoutNode):boolean=>node.type==="group" ? node.tabs.includes(target) : contains(node.first)||contains(node.second);
  const find=(node:LayoutNode):{id:string;first:boolean;fixedNavigation:boolean}|null=>{
    if(node.type==="group") return null;
    const inFirst=contains(node.first),inSecond=contains(node.second);
    if(!inFirst&&!inSecond) return null;
    const deeper=find(inFirst?node.first:node.second);
    if(deeper) return deeper;
    const fixedNavigation=node.axis==="vertical"&&((node.first.type==="group"&&node.first.active==="navigation")||(node.second.type==="group"&&node.second.active==="navigation"));
    return node.axis===(axis==="width"?"horizontal":"vertical") ? {id:node.id,first:inFirst,fixedNavigation} : null;
  };
  const revealed=revealPanel(layout,target);
  const split=find(visibleRoot(revealed));
  if(!split) return fail(`Для панели «${panelLabels[target]}» нет разделителя по ${axis==="width"?"ширине":"высоте"}.`);
  if(split.fixedNavigation)return fail("Высота этой области задаётся свёрнутой или раскрытой навигацией JavaBlueprints. Измените её состояние или используйте другой разделитель.");
  const ratio=split.first?percent/100:1-percent/100;
  return {layout:resizeSplit(revealed,split.id,ratio),result:{ok:true,message:`${axis==="width"?"Ширина":"Высота"} области «${panelLabels[target]}» — ${percent}% ближайшей разделённой области.`}};
}

/** Bounded workspace operations, using the same tiling and persistence paths as UI controls. */
export async function executeWorkspaceAction(c: WorkspaceController,args:Record<string,unknown>):Promise<AssistantResult> {
  const operation=args.operation;
  const selected=panel(args.panel);
  if(typeof operation!=="string") return failure("Не указана операция с окнами.");
  if(["open","hide","toggle","maximize","swap","resize"].includes(operation) && !selected) return failure("Панель не найдена в текущем интерфейсе.");
  if(operation==="save"||operation==="save_default") {
    const saved=c.saveLayout(operation==="save_default");
    return saved ? {ok:true,message:operation==="save_default"?"Базовое расположение сохранено.":"Расположение проекта сохранено."} : failure("Не удалось сохранить расположение: хранилище браузера недоступно.");
  }
  if(operation==="restore") { await c.restoreLayout();return {ok:true,message:"Расположение восстановлено из сохранённого; при отсутствии сохранения используется стандартное."}; }
  if(operation==="reset") { await c.preset("default");return {ok:true,message:"Стандартная компоновка панелей восстановлена."}; }
  if(operation==="preset") {
    if(!["default","code","review"].includes(String(args.preset))) return failure("Неизвестный вариант расположения.");
    await c.preset(args.preset as "default"|"code"|"review");return {ok:true,message:`Применено расположение «${args.preset}».`};
  }
  if(operation==="unmaximize") { await c.maximize(null);return {ok:true,message:"Возвращён обычный размер панелей."}; }
  if(operation==="dock_navigation"||operation==="undock_navigation") {
    const dock=operation==="dock_navigation";
    if(c.navigationDocked!==dock)c.toggleNavigationDock();
    await c.animateLayout(l=>l);
    return {ok:true,message:`Навигация JavaBlueprints ${dock?"закреплена":"откреплена"}.`};
  }
  if(operation==="collapse_navigation"||operation==="expand_navigation") {
    const collapse=operation==="collapse_navigation";
    if(c.collapsedNavigation!==collapse)c.toggleNavigation();
    await c.animateLayout(l=>l);
    return {ok:true,message:`Навигация JavaBlueprints ${collapse?"свёрнута":"раскрыта"}.`};
  }
  if(!selected) return failure("Неизвестная операция с окнами.");
  if(operation==="open" || operation==="hide" || operation==="toggle") {
    const shown=(selected==="navigation"&&c.navigationDocked)||(activePanels(c.layout).includes(selected)&&(!c.maximized||c.maximized===selected));
    const opening=operation==="open"||(operation==="toggle"&&!shown);
    if(!opening&&selected==="graph") return failure("Схема — постоянный холст; скрыть её нельзя.");
    if(selected==="navigation"&&c.navigationDocked) {
      if(opening) { if(c.collapsedNavigation)c.toggleNavigation();return {ok:true,message:"Навигация JavaBlueprints раскрыта."}; }
      c.toggleNavigationDock();
    }
    if(opening) await c.reveal(selected); else await c.hide(selected);
    return {ok:true,message:`Панель «${panelLabels[selected]}» ${opening?"открыта":"скрыта"}. Её положение сохранено.`};
  }
  if(operation==="maximize") {
    if(selected==="navigation") {if(c.navigationDocked)c.toggleNavigationDock();if(c.collapsedNavigation)c.toggleNavigation();}
    await c.reveal(selected);await c.maximize(selected);return {ok:true,message:`Панель «${panelLabels[selected]}» развёрнута.`};
  }
  if(operation==="swap") {
    const target=panel(args.targetPanel);if(!target)return failure("Вторая панель не найдена.");
    const undock=c.navigationDocked&&(selected==="navigation"||target==="navigation");
    const next=swapWorkspacePanels(undock?revealPanel(c.layout,"navigation"):c.layout,selected,target);
    if(next.result.ok) {if(undock)c.toggleNavigationDock();await c.maximize(null);await c.animateLayout(()=>next.layout);}
    return next.result;
  }
  if(operation==="resize") {
    if(args.axis!=="width"&&args.axis!=="height")return failure("Укажите ширину или высоту панели.");
    const undock=selected==="navigation"&&c.navigationDocked;
    const next=resizeWorkspacePanel(undock?revealPanel(c.layout,"navigation"):c.layout,selected,args.axis,typeof args.percent==="number"?args.percent:NaN);
    if(next.result.ok) {if(undock)c.toggleNavigationDock();await c.maximize(null);await c.animateLayout(()=>next.layout);}
    return next.result;
  }
  return failure("Неизвестная операция с окнами.");
}
