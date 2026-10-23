package dev.javablueprints.runner;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import java.util.*;

class ClassArchiveTest {
    @Test void classBundleRoundTripNestedAndAnonymous()throws Exception{var map=Map.of("p/Foo$1.class",new byte[]{1,2,3},"p/Foo.class",new byte[2048]);var read=ClassArchive.unpack(ClassArchive.pack(map));assertArrayEquals(map.get("p/Foo$1.class"),read.get("p/Foo$1.class"));assertArrayEquals(map.get("p/Foo.class"),read.get("p/Foo.class"));}
    @Test void rejectsSymlinkHardlinkSpecialAbsoluteTraversalDuplicateAndTruncation()throws Exception{
        byte[] clean=ClassArchive.pack(Map.of("A.class",new byte[]{1,2,3}));
        for(byte type:new byte[]{'1','2','3','4','6','x','L'}){byte[] hostile=clean.clone();hostile[156]=type;checksum(hostile);assertThrows(Exception.class,()->ClassArchive.unpack(hostile));}
        for(String path:List.of("../A.class","/A.class","a/../../A.class")){byte[] hostile=clean.clone();Arrays.fill(hostile,0,100,(byte)0);System.arraycopy(path.getBytes(),0,hostile,0,path.length());checksum(hostile);assertThrows(Exception.class,()->ClassArchive.unpack(hostile));}
        byte[] duplicate=new byte[3072];System.arraycopy(clean,0,duplicate,0,1024);System.arraycopy(clean,0,duplicate,1024,1024);assertThrows(Exception.class,()->ClassArchive.unpack(duplicate));
        assertThrows(Exception.class,()->ClassArchive.unpack(Arrays.copyOf(clean,513)));
        byte[] invalid=clean.clone();invalid[20]=99;assertThrows(Exception.class,()->ClassArchive.unpack(invalid));
    }
    private void checksum(byte[] b){Arrays.fill(b,148,156,(byte)' ');int n=0;for(int i=0;i<512;i++)n+=b[i]&255;byte[] s=String.format("%06o",n).getBytes();System.arraycopy(s,0,b,148,s.length);b[154]=0;b[155]=' ';}
}
