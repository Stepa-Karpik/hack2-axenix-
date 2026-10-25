package dev.javablueprints.server;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ImmutableResourceCacheTest {
  private final String p=UUID.randomUUID().toString(),a=UUID.randomUUID().toString();
  private final String sql="SELECT data::text FROM resources WHERE project_id=? AND id=? AND kind=?";
  private Workspace workspace(JdbcTemplate database){return new Workspace(database,mock(PlatformTransactionManager.class));}

  @Test void repeatedAnalysisReadsAvoidDatabaseAndReturnedTreesCannotContaminateAnotherRequest() {
    var db=mock(JdbcTemplate.class);var w=workspace(db);
    when(db.queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis")).thenReturn(List.of(Map.of("data","{\"graph\":{\"nodes\":[{\"label\":\"original\"}]},\"optional\":null}")));
    var first=w.resource(p,a,"analysis");assertSame(first,w.resource(p,a,"analysis"));
    assertThrows(UnsupportedOperationException.class,()->first.put("graph",Map.of()));
    var nodes=(List<Map<String,Object>>)((Map<?,?>)first.get("graph")).get("nodes");
    assertThrows(UnsupportedOperationException.class,()->nodes.getFirst().put("label","corrupted"));
    assertThrows(UnsupportedOperationException.class,()->nodes.clear());
    assertEquals("original",nodes.getFirst().get("label"));assertNull(first.get("optional"));
    verify(db,times(1)).queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis");
  }

  @Test void projectAndKindRemainPartOfEveryLookupAndMutableProposalsAreNeverCached() {
    var db=mock(JdbcTemplate.class);var w=workspace(db);String other=UUID.randomUUID().toString();
    when(db.queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis")).thenReturn(List.of(Map.of("data","{\"label\":\"one\"}")));
    when(db.queryForList(sql,Workspace.uuid(other),Workspace.uuid(a),"analysis")).thenReturn(List.of());
    when(db.queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"proposal")).thenReturn(List.of(Map.of("data","{\"status\":\"ready\"}")),List.of(Map.of("data","{\"status\":\"applied\"}")));
    w.resource(p,a,"analysis");assertThrows(ApiError.class,()->w.resource(other,a,"analysis"));
    assertEquals("ready",w.resource(p,a,"proposal").get("status"));assertEquals("applied",w.resource(p,a,"proposal").get("status"));
  }

  @Test void transactionSnapshotsNeverEnterTheSharedCache() {
    var db=mock(JdbcTemplate.class);var w=workspace(db);
    when(db.queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis")).thenReturn(List.of(Map.of("data","{\"label\":\"uncommitted\"}")),List.of(Map.of("data","{\"label\":\"committed\"}")));
    TransactionSynchronizationManager.setActualTransactionActive(true);
    try {assertEquals("uncommitted",w.resource(p,a,"analysis").get("label"));}
    finally {TransactionSynchronizationManager.setActualTransactionActive(false);}
    assertEquals("committed",w.resource(p,a,"analysis").get("label"));
    assertEquals("committed",w.resource(p,a,"analysis").get("label"));
    verify(db,times(2)).queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis");
  }

  @Test void weightedLruEvictsOldEntriesAndBypassesOversizedGraphs() {
    var cache=new ImmutableResourceCache(160,2);var project=UUID.randomUUID();
    var one=new ImmutableResourceCache.Key(project,UUID.randomUUID());var two=new ImmutableResourceCache.Key(project,UUID.randomUUID());var three=new ImmutableResourceCache.Key(project,UUID.randomUUID());
    cache.put(one,Map.of("v",1),10);cache.put(two,Map.of("v",2),10);cache.get(one);cache.put(three,Map.of("v",3),10);
    assertNull(cache.get(two));assertNotNull(cache.get(one));assertNotNull(cache.get(three));assertEquals(2,cache.size());assertTrue(cache.weight()<=160);
    cache.put(two,Map.of("v",2),1000);assertNull(cache.get(two));assertEquals(2,cache.size());
  }

  @Test void cachedAnalysisStillRequiresTheRequestedRevisionBinding() {
    var db=mock(JdbcTemplate.class);var w=workspace(db);
    String revision=UUID.randomUUID().toString(),other=UUID.randomUUID().toString();
    when(db.queryForObject("SELECT EXISTS(SELECT 1 FROM revisions WHERE project_id=? AND id=?)",Boolean.class,Workspace.uuid(p),Workspace.uuid(revision))).thenReturn(true);
    when(db.queryForObject("SELECT EXISTS(SELECT 1 FROM revisions WHERE project_id=? AND id=?)",Boolean.class,Workspace.uuid(p),Workspace.uuid(other))).thenReturn(true);
    when(db.queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis")).thenReturn(List.of(Map.of("data","{\"revisionId\":\""+revision+"\"}")));
    w.analysis(p,revision,a);
    var conflict=assertThrows(ApiError.class,()->w.analysis(p,other,a));
    assertEquals("ANALYSIS_CONFLICT",conflict.code);
    verify(db,times(1)).queryForList(sql,Workspace.uuid(p),Workspace.uuid(a),"analysis");
  }
}
