package dev.javablueprints.server;

import java.util.*;

/** Process-local, weighted LRU of DB-enforced immutable analyses. No authorization state is cached. */
final class ImmutableResourceCache {
  record Key(UUID project, UUID resource) {}
  private record Entry(Map<String,Object> value,long weight) {}
  private final LinkedHashMap<Key,Entry> entries=new LinkedHashMap<>(16,.75f,true);
  private final long maximumWeight;
  private final int maximumEntries;
  private long weight;

  ImmutableResourceCache(long maximumWeight,int maximumEntries) {
    this.maximumWeight=maximumWeight;this.maximumEntries=maximumEntries;
  }
  synchronized Map<String,Object> get(Key key) {
    Entry entry=entries.get(key);return entry==null?null:entry.value();
  }
  synchronized Map<String,Object> put(Key key,Map<String,Object> value,int encodedCharacters) {
    // Conservative accounting units, not a measured JVM heap limit. Oversized analyses are read normally.
    long cost=Math.max(1,encodedCharacters)*8L;
    if(cost>maximumWeight)return value;
    var immutable=(Map<String,Object>)freeze(value);
    Entry old=entries.put(key,new Entry(immutable,cost));
    if(old!=null)weight-=old.weight();
    weight+=cost;
    while(weight>maximumWeight||entries.size()>maximumEntries) {
      var iterator=entries.entrySet().iterator();var eldest=iterator.next();weight-=eldest.getValue().weight();iterator.remove();
    }
    return immutable;
  }
  synchronized int size(){return entries.size();}
  synchronized long weight(){return weight;}
  private static Object freeze(Object value) {
    if(value instanceof Map<?,?> map) {
      var copy=new LinkedHashMap<String,Object>();map.forEach((key,item)->copy.put((String)key,freeze(item)));
      return Collections.unmodifiableMap(copy);
    }
    if(value instanceof List<?> list) {
      var copy=new ArrayList<>();list.forEach(item->copy.add(freeze(item)));return Collections.unmodifiableList(copy);
    }
    return value;
  }
}
