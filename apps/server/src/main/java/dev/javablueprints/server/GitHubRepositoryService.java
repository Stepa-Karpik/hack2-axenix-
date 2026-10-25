package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static dev.javablueprints.server.GitHubClient.*;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** Immutable Git objects become strict text previews; this service never writes project sources. */
@Service
final class GitHubRepositoryService {
  final GitHubService auth;final GitHubClient client;
  record Entry(String name,String sha,String type,String mode,long size){}
  static final class Snapshot {
    final String id,account,session,grant,repositoryId,repositoryPath,commit,root,ref;final int authVersion;final Instant expires;
    final Map<String,List<Entry>> trees=new HashMap<>();int cachedEntries=0;
    Snapshot(String id,GitHubService.Credential credential,String session,int version,String repositoryId,String path,String commit,String root,String ref){
      this.id=id;account=credential.account();this.session=session;grant=credential.version();authVersion=version;this.repositoryId=repositoryId;repositoryPath=path;this.commit=commit;this.root=root;this.ref=ref;expires=Instant.now().plusSeconds(600);
    }
  }
  final Map<String,Snapshot> snapshots=new ConcurrentHashMap<>();
  GitHubRepositoryService(GitHubService auth,GitHubClient client){this.auth=auth;this.client=client;}
  private int page(int page){if(page<1||page>1000)throw error(400,"INVALID_REQUEST","Invalid GitHub page");return page;}
  Map<String,Object> repositories(HttpServletRequest request,int page){
    var credential=auth.credential(request);var list=list(client.get("/user/repos?per_page=30&sort=full_name&page="+page(page),credential.token(),2*1024*1024));
    if(list.size()>30)throw error(502,"GITHUB_RESPONSE_INVALID","GitHub page exceeds requested count");
    var items=list.stream().map(r->map("id",numeric(r.get("id")),"owner",component(object(r.get("owner")).get("login")),"name",component(r.get("name")),"private",Boolean.TRUE.equals(r.get("private")),"defaultBranch",Objects.toString(r.get("default_branch"),""))).toList();
    revalidate(request,credential);
    return map("items",items,"nextPage",list.size()==30?page+1:null);
  }
  Map<String,Object> refs(HttpServletRequest request,String repositoryId,String kind,int page){
    if(!Set.of("branches","tags").contains(kind))throw error(400,"INVALID_REQUEST","Unknown GitHub ref kind");
    var credential=auth.credential(request);String path=repository(credential,repositoryId);
    var values=list(client.get(path+"/"+kind+"?per_page=30&page="+page(page),credential.token(),1024*1024));
    if(values.size()>30)throw error(502,"GITHUB_RESPONSE_INVALID","GitHub page exceeds requested count");
    var items=values.stream().map(v->map("name",Objects.toString(v.get("name"),""),"kind",kind,"commitSha",sha(object(v.get("commit")).get("sha")))).toList();
    revalidate(request,credential);return map("items",items,"nextPage",values.size()==30?page+1:null);
  }
  Map<String,Object> snapshot(HttpServletRequest request,String repositoryId,String ref){
    if(ref.isBlank()||ref.length()>255||ref.codePoints().anyMatch(Character::isISOControl))throw error(400,"INVALID_REQUEST","Choose a branch, tag or commit");
    var credential=auth.credential(request);String path=repository(credential,repositoryId);
    var commit=object(client.get(path+"/commits/"+segment(ref),credential.token(),2*1024*1024));
    String commitSha=sha(commit.get("sha")),tree=sha(object(object(commit.get("commit")).get("tree")).get("sha"));
    revalidate(request,credential);
    var snapshot=new Snapshot(id(),credential,auth.sessionBinding(request),auth.authVersion(credential.account()),numeric(repositoryId),path,commitSha,tree,ref);
    synchronized(snapshots){
      snapshots.entrySet().removeIf(e->e.getValue().expires.isBefore(Instant.now()));
      if(snapshots.size()>=64||snapshots.values().stream().filter(s->s.account.equals(credential.account())).count()>=8)throw error(429,"GITHUB_RATE_LIMITED","Too many active repository snapshots");
      snapshots.put(snapshot.id,snapshot);
    }
    return map("snapshotId",snapshot.id,"repositoryId",snapshot.repositoryId,"repository",path.substring("/repos/".length()),"ref",ref,"commitSha",commitSha,"rootTreeSha",tree,"expiresAt",snapshot.expires.toString());
  }
  Map<String,Object> tree(HttpServletRequest request,String snapshotId,String path){
    var credential=auth.credential(request);var snapshot=bound(request,snapshotId,credential);
    if(!repository(credential,snapshot.repositoryId).equals(snapshot.repositoryPath))throw error(409,"GITHUB_SNAPSHOT_EXPIRED","Repository identity changed; choose the ref again");
    if(!path.isEmpty())TextTree.path(path);
    synchronized(snapshot){
      String sha=directory(snapshot,path,credential.token());
      var entries=entries(snapshot,sha,credential.token()).stream().map(e->{
        String reason=reason(e);String full=path.isEmpty()?e.name():path+"/"+e.name();
        return map("path",full,"type",e.type(),"size",e.size(),"selectable",reason==null,"reason",reason);
      }).toList();
      revalidate(request,credential);return map("entries",entries,"complete",true,"commitSha",snapshot.commit);
    }
  }
  Map<String,Object> preview(HttpServletRequest request,String snapshotId,List<String> paths,List<String> folders,boolean all){
    var credential=auth.credential(request);var snapshot=bound(request,snapshotId,credential);
    if(paths.size()+folders.size()>TextTree.MAX_ENTRIES)throw TextTree.limit();
    if(new HashSet<>(paths).size()!=paths.size()||new HashSet<>(folders).size()!=folders.size()||paths.stream().anyMatch(folders::contains))throw error(400,"GITHUB_PATH_INVALID","Duplicate selected path");
    for(String folder:folders)if(paths.stream().anyMatch(p->p.startsWith(folder+"/"))||folders.stream().anyMatch(f->!f.equals(folder)&&f.startsWith(folder+"/")))throw error(400,"GITHUB_PATH_INVALID","Selected files/folders overlap");
    var files=new TreeMap<String,String>();var directories=new TreeSet<String>();var hashes=new TreeMap<String,String>();long[] bytes={0};
    synchronized(snapshot){
      var selected=new LinkedHashMap<String,Entry>();
      if(all){if(!paths.isEmpty()||!folders.isEmpty())throw error(400,"INVALID_REQUEST","All-text selection cannot also name paths");collect(snapshot,"",snapshot.root,credential.token(),selected,directories,new HashSet<>());}
      else{
        for(String path:paths){TextTree.path(path);int slash=path.lastIndexOf('/');String parent=slash<0?"":path.substring(0,slash),name=path.substring(slash+1);String tree=directory(snapshot,parent,credential.token());
          var entry=entries(snapshot,tree,credential.token()).stream().filter(e->e.name().equals(name)).findFirst().orElseThrow(()->error(400,"GITHUB_PATH_INVALID","Selected file is not in this snapshot"));
          if(!entry.type().equals("blob")||reason(entry)!=null)throw error(422,"GITHUB_ENTRY_UNSUPPORTED","Unsupported selected entry: "+path);
          if(selected.put(path,entry)!=null)throw error(400,"GITHUB_PATH_INVALID","Duplicate selected path: "+path);
        }
        for(String folder:folders){TextTree.path(folder);String tree=directory(snapshot,folder,credential.token());collect(snapshot,folder,tree,credential.token(),selected,directories,new HashSet<>());}
      }
      if(selected.isEmpty()&&directories.isEmpty())throw error(400,"GITHUB_SELECTION_EMPTY","Choose files or a folder");
      for(var selectedFile:selected.entrySet()){
        String path=selectedFile.getKey();Entry entry=selectedFile.getValue();bytes[0]+=entry.size();if(bytes[0]>TextTree.MAX_BYTES)throw TextTree.limit();
        byte[] raw=client.blob(snapshot.repositoryPath,entry.sha(),credential.token());
        if(raw.length!=entry.size())throw error(502,"GITHUB_RESPONSE_INVALID","GitHub file size differs: "+path);
        String source;try{source=TextTree.decode(raw);}catch(ApiError ignored){throw error(422,"GITHUB_TEXT_REQUIRED","Selected file is not strict UTF-8 text: "+path);}
        if(source.indexOf(0)>=0)throw error(422,"GITHUB_TEXT_REQUIRED","Selected file contains binary data: "+path);
        files.put(path,source);hashes.put(path,hash(raw));
      }
      var text=new TextTree(files,directories);revalidate(request,credential);
      var preview=new LinkedHashMap<>(text.preview());
      preview.put("provenance",map("provider","github","repositoryId",snapshot.repositoryId,"repository",snapshot.repositoryPath.substring(7),"ref",snapshot.ref,"commitSha",snapshot.commit,"treeSha",snapshot.root,"rawHashes",hashes));
      return preview;
    }
  }
  private void collect(Snapshot snapshot,String path,String tree,String token,Map<String,Entry> selected,Set<String> directories,Set<String> ancestors){
    if(!ancestors.add(tree))throw error(502,"GITHUB_RESPONSE_INVALID","GitHub tree cycle detected");
    if(!path.isEmpty())directories.add(path);
    for(Entry entry:entries(snapshot,tree,token)){
      String full=path.isEmpty()?entry.name():path+"/"+entry.name();TextTree.path(full);
      if(reason(entry)!=null)throw error(422,"GITHUB_ENTRY_UNSUPPORTED","Selection includes unsupported entry: "+full+" ("+reason(entry)+")");
      if(entry.type().equals("tree"))collect(snapshot,full,entry.sha(),token,selected,directories,ancestors);
      else if(selected.put(full,entry)!=null)throw error(400,"GITHUB_PATH_INVALID","Selected files/folders overlap: "+full);
      if(selected.size()+directories.size()>TextTree.MAX_ENTRIES)throw TextTree.limit();
    }
    ancestors.remove(tree);
  }
  private String reason(Entry entry){
    if(entry.type().equals("tree")&&entry.mode().equals("040000"))return null;
    if(entry.type().equals("blob")&&Set.of("100644","100755").contains(entry.mode()))return entry.size()>TextTree.MAX_BYTES?"Файл больше 1МиБ":null;
    return "Symlink, submodule or unsupported Git entry";
  }
  private String directory(Snapshot snapshot,String path,String token){
    String tree=snapshot.root;if(path.isEmpty())return tree;
    for(String name:path.split("/")){
      var entry=entries(snapshot,tree,token).stream().filter(e->e.name().equals(name)).findFirst().orElseThrow(()->error(400,"GITHUB_PATH_INVALID","Folder is not in this snapshot"));
      if(!entry.type().equals("tree")||!entry.mode().equals("040000"))throw error(422,"GITHUB_ENTRY_UNSUPPORTED","Selected path is not an ordinary folder");tree=entry.sha();
    }
    return tree;
  }
  private List<Entry> entries(Snapshot snapshot,String tree,String token){
    if(snapshot.trees.containsKey(tree))return snapshot.trees.get(tree);
    if(snapshot.trees.size()>=128)throw error(413,"GITHUB_INPUT_LIMIT","Snapshot tree traversal budget exceeded");
    var value=object(client.get(snapshot.repositoryPath+"/git/trees/"+tree,token,2*1024*1024));
    if(!tree.equals(value.get("sha"))||!Boolean.FALSE.equals(value.get("truncated")))throw error(413,"GITHUB_TREE_INCOMPLETE","GitHub tree is truncated or incomplete; no partial import was produced");
    var values=list(value.get("tree"));if(snapshot.cachedEntries+values.size()>5000)throw error(413,"GITHUB_INPUT_LIMIT","Snapshot listing budget exceeded");if(values.size()>2000)throw error(413,"GITHUB_INPUT_LIMIT","Folder listing exceeds 2000 entries; no partial listing was returned");
    var names=new HashSet<String>();var entries=new ArrayList<Entry>();
    for(var item:values){String name=Objects.toString(item.get("path"),"");TextTree.path(name);if(name.contains("/")||!names.add(name))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid or duplicate GitHub tree entry");
      long size=item.get("size") instanceof Number n?n.longValue():0;if(size<0)throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub blob size");
      entries.add(new Entry(name,sha(item.get("sha")),Objects.toString(item.get("type"),""),Objects.toString(item.get("mode"),""),size));
    }
    snapshot.cachedEntries+=entries.size();snapshot.trees.put(tree,List.copyOf(entries));return entries;
  }
  private Snapshot bound(HttpServletRequest request,String id,GitHubService.Credential credential){
    var snapshot=snapshots.get(id);
    if(snapshot==null||!snapshot.expires.isAfter(Instant.now())||!snapshot.account.equals(credential.account())||!snapshot.session.equals(auth.sessionBinding(request))||!snapshot.grant.equals(credential.version())||snapshot.authVersion!=auth.authVersion(credential.account()))throw error(409,"GITHUB_SNAPSHOT_EXPIRED","Repository snapshot expired or authorization changed; choose the ref again");
    return snapshot;
  }
  private void revalidate(HttpServletRequest request,GitHubService.Credential previous){var current=auth.credential(request);if(!current.account().equals(previous.account())||!current.version().equals(previous.version()))throw error(409,"GITHUB_RECONNECT","GitHub authorization changed during the request");}
  private String repository(GitHubService.Credential credential,String id){
    id=numeric(id);var repo=object(client.get("/repositories/"+id,credential.token(),262144));
    if(!id.equals(numeric(repo.get("id"))))throw error(502,"GITHUB_RESPONSE_INVALID","GitHub repository identity differs");
    return "/repos/"+segment(component(object(repo.get("owner")).get("login")))+"/"+segment(component(repo.get("name")));
  }
  private static String component(Object value){String name=Objects.toString(value,"");if(!name.matches("[A-Za-z0-9_.-]{1,100}"))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub repository name");return name;}
}
