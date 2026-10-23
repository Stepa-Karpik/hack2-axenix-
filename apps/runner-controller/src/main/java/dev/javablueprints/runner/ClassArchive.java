package dev.javablueprints.runner;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static dev.javablueprints.verification.RunnerProtocol.path;

/** Minimal bounded ustar, regular files only. No extraction to the host filesystem. */
final class ClassArchive {
    static byte[] pack(Map<String,byte[]> files)throws IOException {
        var out=new ByteArrayOutputStream();
        for(var entry:files.entrySet()) {
            String name=entry.getKey(); path(name);byte[] header=new byte[512];
            if(name.length()>100) {int split=name.lastIndexOf('/'); if(split<0||split>155||name.length()-split-1>100)throw new IOException("Archive name");put(header,345,155,name.substring(0,split));name=name.substring(split+1);}
            put(header,0,100,name);put(header,100,8,"0000644");put(header,108,8,"0017776");put(header,116,8,"0017776");put(header,124,12,String.format("%011o",entry.getValue().length));put(header,136,12,"00000000000");Arrays.fill(header,148,156,(byte)' ');header[156]='0';put(header,257,6,"ustar");put(header,263,2,"00");int checksum=0;for(byte b:header)checksum+=b&255;put(header,148,8,String.format("%06o",checksum));header[154]=0;header[155]=' ';out.write(header);out.write(entry.getValue());out.write(new byte[(512-entry.getValue().length%512)%512]);
        }
        out.write(new byte[1024]);return out.toByteArray();
    }
    static Map<String,byte[]> unpack(byte[] archive)throws IOException {
        var result=new TreeMap<String,byte[]>();int offset=0,total=0;boolean terminated=false;
        while(offset+512<=archive.length) {
            byte[] h=Arrays.copyOfRange(archive,offset,offset+512);offset+=512;
            if(h[0]==0){if(offset+512>archive.length)throw new IOException("Truncated archive terminator");for(int i=offset-512;i<archive.length;i++)if(archive[i]!=0)throw new IOException("Invalid archive terminator");terminated=true;break;}
            if(!text(h,257,6).equals("ustar"))throw new IOException("Archive format");
            int check=0;for(int i=0;i<512;i++)check+=(i>=148&&i<156)?32:h[i]&255;
            if(octal(h,148,8)!=check)throw new IOException("Archive checksum");
            long size=octal(h,124,12);if(size<0||size>8*1024*1024||offset+size>archive.length)throw new IOException("Archive size");
            String name=text(h,0,100);String prefix=text(h,345,155);if(!prefix.isEmpty())name=prefix+"/"+name;
            while(name.startsWith("./"))name=name.substring(2);
            byte type=h[156];
            if(type=='5') {if(size!=0||(!name.isEmpty()&&!name.equals(".")&&!name.matches("[A-Za-z_$][A-Za-z0-9_$]*(/[A-Za-z_$][A-Za-z0-9_$]*)*/?")))throw new IOException("Archive directory");}
            else {if(type!='0'&&type!=0)throw new IOException("Archive type");path(name);if(!name.endsWith(".class")||result.size()>=1000||(total+=size)>8*1024*1024||result.containsKey(name))throw new IOException("Class bundle limit");result.put(name,Arrays.copyOfRange(archive,offset,offset+(int)size));}
            offset+=(int)((size+511)/512*512);if(offset>archive.length)throw new IOException("Archive padding");
        }
        if(result.isEmpty()||!terminated)throw new IOException("Empty or truncated class bundle");return Collections.unmodifiableMap(result);
    }
    private static void put(byte[] b,int off,int max,String s){byte[] v=s.getBytes(StandardCharsets.US_ASCII);if(v.length>max)throw new IllegalArgumentException("Tar field");System.arraycopy(v,0,b,off,v.length);}
    private static String text(byte[] h,int off,int len){int end=off;while(end<off+len&&h[end]!=0)end++;return new String(h,off,end-off,StandardCharsets.US_ASCII);}
    private static long octal(byte[] h,int off,int len)throws IOException{try{return Long.parseLong(text(h,off,len).trim(),8);}catch(NumberFormatException e){throw new IOException("Tar integer",e);}}
}
