package dev.javablueprints.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import java.sql.DriverManager;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in read-only measurement against the exact previously-created G6 fixture. */
class WorkspaceReadProfileTest {
  @Test @EnabledIfEnvironmentVariable(named="JB_READ_PROFILE",matches="1")
  void measureLargeImmutableAnalysisReadPath() throws Exception {
    String project="1790d4fd-3a17-4010-9e42-f95f6cd6295c",revision="7448d27f-4188-4fb6-8196-5f4b091d6799";
    String url="jdbc:postgresql://"+System.getenv().getOrDefault("JB_DB_HOST","127.0.0.1")+":"
        +System.getenv().getOrDefault("JB_DB_PORT","55433")+"/"+System.getenv().getOrDefault("JB_DB_NAME","java_blueprints");
    try(var connection=DriverManager.getConnection(url,System.getenv().getOrDefault("JB_DB_USER","java_blueprints"),System.getenv("JB_DB_PASSWORD"))) {
      connection.setReadOnly(true);
      var source=new SingleConnectionDataSource(connection,true);
      var workspace=new Workspace(new JdbcTemplate(source),new DataSourceTransactionManager(source));
      var rows=workspace.db.queryForList("SELECT id::text,data::text FROM resources WHERE project_id=? AND kind='analysis' AND data->>'revisionId'=? ORDER BY created_at DESC LIMIT 1",Workspace.uuid(project),revision);
      assertEquals(1,rows.size(),"Owned G6 fixture must already exist; this test creates nothing");
      String analysis=rows.getFirst().get("id").toString(),encoded=rows.getFirst().get("data").toString();
      var metadata=workspace.decode(encoded);
      String lookup="SELECT id::text FROM resources WHERE project_id=? AND kind='analysis' AND data->>'revisionId'=? AND data->>'analyzerVersion'=? AND data->>'sourceMapVersion'=? AND data->>'symbolEnvironmentHash'=? ORDER BY created_at DESC,resources.id DESC LIMIT 1";
      Object[] parameters={Workspace.uuid(project),revision,metadata.get("analyzerVersion"),metadata.get("sourceMapVersion"),metadata.get("symbolEnvironmentHash")};
      var measurements=new LinkedHashMap<String,List<Double>>();
      for(int i=0;i<8;i++) {
        measure(measurements,"exactAnalysisReadMs",()->workspace.analysis(project,revision,analysis));
        measure(measurements,"rawLatestAnalysisReadMs",()->workspace.db.queryForList("SELECT data::text FROM resources WHERE project_id=? AND kind='analysis' AND data->>'revisionId'=? ORDER BY created_at DESC,id DESC LIMIT 1",Workspace.uuid(project),revision));
        measure(measurements,"provenanceIdLookupMs",()->workspace.db.queryForList(lookup,parameters));
        measure(measurements,"decodeMs",()->workspace.decode(encoded));
        var decoded=workspace.decode(encoded);
        measure(measurements,"encodeMs",()->workspace.encode(decoded));
      }
      var report=new LinkedHashMap<String,Object>();
      report.put("source","existing-owned-G6-read-only");report.put("analysisChars",encoded.length());
      report.put("provenanceLookupPlan",workspace.db.queryForList("EXPLAIN "+lookup,parameters));
      report.put("warmSamples",6);
      report.put("nodes",((List<?>)((Map<?,?>)workspace.decode(encoded).get("graph")).get("nodes")).size());
      measurements.forEach((name,times)->{var sorted=times.stream().skip(2).sorted().toList();report.put(name,Workspace.map("median",sorted.get(sorted.size()/2),"max",sorted.getLast()));});
      System.out.println("READ_PROFILE "+workspace.encode(report));
    }
  }
  private static void measure(Map<String,List<Double>> values,String name,java.util.function.Supplier<Object> read) {
    long started=System.nanoTime();assertNotNull(read.get());values.computeIfAbsent(name,ignored->new ArrayList<>()).add((System.nanoTime()-started)/1_000_000.0);
  }
}
